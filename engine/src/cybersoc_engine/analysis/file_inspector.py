import os
import stat
from builtins import open as open_binary
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter

from cybersoc_engine.analysis.windows_io import readonly_opener
from cybersoc_engine.errors import map_file_error
from cybersoc_engine.models import (
    EngineResult,
    FileError,
    FileInfo,
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
                self.pipeline.analyze(fh, result)
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
            self.pipeline.complete_skipped(result)
            assessment = RiskScorer().evaluate(result)
            result.verdict = assessment.verdict
            result.score = assessment.score
            result.riskLevel = assessment.riskLevel
            result.durationMs = (perf_counter() - started) * 1000
        return result
