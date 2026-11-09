import os
import stat
from builtins import open as open_binary
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter

from cybersoc_engine.analysis.stream import FileChangedError
from cybersoc_engine.analysis.windows_io import readonly_opener
from cybersoc_engine.errors import map_file_error
from cybersoc_engine.models import (
    EngineResult,
    FileError,
    FileInfo,
    LayerTrace,
    ScanFileOptions,
)
from cybersoc_engine.pipeline import AnalysisPipeline
from cybersoc_engine.scoring.risk_scorer import RiskScorer
from cybersoc_engine.version import ENGINE_VERSION

# Windows file attributes not exposed by Python 3.12's stat module.
FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x00040000
FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000
CLOUD_ATTRIBUTES = (
    stat.FILE_ATTRIBUTE_OFFLINE
    | FILE_ATTRIBUTE_RECALL_ON_OPEN
    | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
)


def _skip_reason(metadata: os.stat_result, options: ScanFileOptions) -> FileError | None:
    if getattr(metadata, "st_file_attributes", 0) & CLOUD_ATTRIBUTES:
        return FileError(code="CLOUD_PLACEHOLDER", message="Archivo de nube no descargado")
    if metadata.st_size > options.maxBytes:
        return FileError(code="TOO_LARGE", message="El archivo supera el tamaño máximo permitido")
    return None


def _file_info(path: Path, metadata: os.stat_result) -> FileInfo:
    return FileInfo(
        name=path.name,
        extension=path.suffix or None,
        sizeBytes=metadata.st_size,
        modifiedAt=datetime.fromtimestamp(metadata.st_mtime, UTC)
        .isoformat()
        .replace("+00:00", "Z"),
    )


def _same_file(
    before: os.stat_result, after: os.stat_result, *, compare_ctime: bool = False
) -> bool:
    # Descriptor/path identity and stable metadata, not atime (reading may change it).
    # O(1) comparison. It is neither an exclusive lock nor a system snapshot.
    # On Windows/Python 3.12 stat and fstat may give ctime different semantics.
    # ctime is only compared between two reads made through the SAME API.
    keys = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
    if compare_ctime:
        keys += ("st_ctime_ns",)
    return stat.S_ISREG(after.st_mode) and all(
        getattr(before, key) == getattr(after, key) for key in keys
    )


class FileInspector:
    def __init__(self) -> None:
        self.pipeline = AnalysisPipeline()

    def inspect(self, path: str, opts: ScanFileOptions, *, task_id: str) -> EngineResult:
        started = perf_counter()
        result = EngineResult(
            taskId=task_id,
            status="ERROR",
            evidence=[],
            layers=[],
            durationMs=0,
            engineVersion=ENGINE_VERSION,
        )
        try:
            # Do not access UNC shares or Windows device namespaces.
            if path.startswith(("\\\\", "//")):
                raise OSError("Only local file paths are supported")
            target = Path(path)
            metadata = target.stat(follow_symlinks=False)
            reason = _skip_reason(metadata, opts)
            if reason is not None:
                result.status = "SKIPPED"
                result.error = reason
                return result
            if not stat.S_ISREG(metadata.st_mode):
                raise OSError("Expected a regular file, not a link or directory")
            result.file = _file_info(target, metadata)
            with open_binary(
                target, "rb", opener=readonly_opener if os.name == "nt" else None
            ) as fh:
                # Recheck the opened file in case its size changed after stat.
                opened = os.fstat(fh.fileno())
                reason = _skip_reason(opened, opts)
                if reason is not None:
                    result.status = "SKIPPED"
                    result.error = reason
                    return result
                result.file = _file_info(target, opened)
                if not _same_file(metadata, opened):
                    raise FileChangedError("File replaced or changed on open")

                def check_unchanged() -> None:
                    try:
                        current = target.stat(follow_symlinks=False)
                        descriptor = os.fstat(fh.fileno())
                    except OSError:
                        raise FileChangedError("Could not verify the open file") from None
                    if not _same_file(opened, descriptor, compare_ctime=True) or not _same_file(
                        metadata, current, compare_ctime=True
                    ):
                        raise FileChangedError("File changed during analysis")

                self.pipeline.analyze(
                    fh,
                    result,
                    opts.layers,
                    zone=opts.zone,
                    attributes=getattr(opened, "st_file_attributes", 0),
                    max_bytes=int(opts.maxBytes),
                    check_unchanged=check_unchanged,
                )
                check_unchanged()
        except FileChangedError:
            # No evidence/hash from an inconsistent read may back a
            # verdict, not even a signature found before the change was detected.
            result.status = "ERROR"
            result.error = FileError(
                code="IO_ERROR", message="El archivo cambió durante el análisis"
            )
            result.hashes = None
            result.model_fields_set.discard("hashes")
            result.evidence.clear()
            result.layers = [
                LayerTrace(layer="HASH", status="ERROR", reason="IO_ERROR", hits=0, points=0, ms=0)
            ]
        except OSError as error:
            result.status = "ERROR"
            result.error = map_file_error(error)
        except ValueError:
            result.status = "ERROR"
            # Invalid filesystem paths (e.g. NUL) are file errors, not RPC failures.
            result.error = FileError(
                code="IO_ERROR", message="Ruta o metadatos de archivo inválidos"
            )
        finally:
            self.pipeline.complete_skipped(result, opts.layers)
            assessment = RiskScorer().evaluate(result)
            result.verdict = assessment.verdict
            result.score = assessment.score
            result.riskLevel = assessment.riskLevel
            result.scoreBreakdown = assessment.scoreBreakdown
            result.durationMs = (perf_counter() - started) * 1000
        return result
