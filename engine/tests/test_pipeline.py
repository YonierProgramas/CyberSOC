import hashlib
import json
from io import BytesIO
from unittest.mock import patch

import pytest
from fixtures.generate import generate_fixtures

from cybersoc_engine.analysis.file_inspector import FileInspector
from cybersoc_engine.engines.filetype_engine import FileTypeEngine
from cybersoc_engine.models import EngineResult, FileInfo, ScanFileOptions, ScanFileResponse
from cybersoc_engine.pipeline import PREFIX_BYTES, AnalysisPipeline
from cybersoc_engine.rpc.server import handle_line


def result_for(name="factura.pdf.exe"):
    return EngineResult(
        taskId="t_pipeline",
        status="ERROR",
        evidence=[],
        layers=[],
        file=FileInfo(name=name, extension=".exe", sizeBytes=5, modifiedAt="now"),
        durationMs=0,
        engineVersion="0.1.0",
    )


def assert_trace(result):
    wire = result.model_dump(exclude_unset=True)
    EngineResult.model_validate(wire)
    assert [trace.layer for trace in result.layers] == ["HASH", "SIGNATURES", "FILETYPE"]
    assert all(trace.ms >= 0 for trace in result.layers)
    assert all(trace.reason for trace in result.layers if trace.status == "SKIPPED")
    assert [item.id for item in result.evidence] == [
        f"ev{i}" for i in range(1, len(result.evidence) + 1)
    ]


def test_pipeline_hash_findings_points_and_no_stale_state():
    pipeline = AnalysisPipeline()
    for _ in range(2):
        result = result_for("informe_\u202e.pdf.exe")
        pipeline.analyze(BytesIO(b"%PDFrelleno"), result)
        pipeline.complete_skipped(result)
        assert_trace(result)
        assert result.hashes.sha256 == hashlib.sha256(b"%PDFrelleno").hexdigest()
        assert [item.code for item in result.evidence] == [
            "TYPE_MISMATCH",
            "DOUBLE_EXTENSION",
            "RLO_IN_NAME",
        ]
        assert result.layers[2].hits == 3
        assert result.layers[2].points == 65
        assert result.layers[0].points == result.layers[0].hits == 0
    clean = result_for("archivo.exe")
    pipeline.analyze(BytesIO(b"Texto benigno"), clean)
    assert clean.evidence == []
    assert_trace(clean)


def test_filetype_failure_preserves_hash_and_marks_error():
    result = result_for()
    with patch.object(FileTypeEngine, "analyze", side_effect=RuntimeError("ruta privada")):
        AnalysisPipeline().analyze(BytesIO(b"texto"), result)
    assert_trace(result)
    assert result.status == "ERROR"
    assert result.hashes.sha256 == hashlib.sha256(b"texto").hexdigest()
    assert result.evidence == []
    assert result.layers[0].status == "RAN"
    assert result.layers[2].status == "ERROR"
    assert result.layers[2].reason == "ANALYSIS_ERROR"
    assert "ruta privada" not in result.model_dump_json()


def test_filetype_read_failure_keeps_successful_hash():
    class CannotRewind(BytesIO):
        def seek(self, *args):
            raise OSError("cannot seek")

    result = result_for()
    AnalysisPipeline().analyze(CannotRewind(b"texto"), result)
    assert_trace(result)
    assert result.layers[0].status == "RAN"
    assert result.layers[2].status == "ERROR"
    assert result.status == "ERROR"


def test_pipeline_reassigns_ids_instead_of_trusting_local_ids():
    from cybersoc_engine.engines.base import AnalysisContext

    result = result_for()
    ctx = AnalysisContext(result.file, b"texto", "a" * 64)
    original = FileTypeEngine().analyze(ctx)[0]
    findings = [original.model_copy(update={"id": "ev91"}) for _ in range(2)]
    with patch.object(FileTypeEngine, "analyze", return_value=findings):
        AnalysisPipeline().analyze(BytesIO(b"texto"), result)
    assert [item.id for item in result.evidence] == ["ev1", "ev2"]
    assert [item.id for item in findings] == ["ev91", "ev91"]
    assert_trace(result)


def test_layer_failure_does_not_break_next_rpc_request(tmp_path):
    path = tmp_path / "normal.txt"
    path.write_bytes(b"Texto benigno")
    request = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "scan.file",
            "params": {
                "jobId": "j",
                "taskId": "t",
                "path": str(path),
                "options": {"maxBytes": 1000},
            },
        }
    ).encode()
    with patch.object(FileTypeEngine, "analyze", side_effect=RuntimeError("test")):
        failed = ScanFileResponse.model_validate_json(handle_line(request).response).result
    assert failed.status == "ERROR"
    assert_trace(failed)
    recovered = ScanFileResponse.model_validate_json(handle_line(request).response).result
    assert recovered.status == "SCANNED"
    assert recovered.error is None
    assert recovered.evidence == []
    assert_trace(recovered)


def test_sample_is_bounded_and_stream_stays_open():
    content = b"Texto benigno." * 100000

    class ObservedStream(BytesIO):
        def __init__(self):
            super().__init__(content)
            self.read_sizes = []

        def read(self, size=-1):
            assert size > 0  # Nunca leer todo de una vez.
            self.read_sizes.append(size)
            return super().read(size)

    stream = ObservedStream()
    result = result_for("archivo.exe")
    with patch.object(FileTypeEngine, "analyze", wraps=FileTypeEngine().analyze) as analyze:
        AnalysisPipeline().analyze(stream, result)
    assert len(analyze.call_args.args[0].prefix) == PREFIX_BYTES
    assert stream.read_sizes[-1] == PREFIX_BYTES
    assert result.hashes.sha256 == hashlib.sha256(content).hexdigest()
    assert not stream.closed


@pytest.mark.parametrize("scenario", ["missing", "oversize", "hash_error"])
def test_every_implemented_layer_is_traced_when_analysis_cannot_run(tmp_path, scenario):
    path = tmp_path / "factura.pdf.exe"
    if scenario != "missing":
        path.write_bytes(b"Texto inocuo")
    with patch.object(FileTypeEngine, "analyze", wraps=FileTypeEngine().analyze) as filetype:
        if scenario == "hash_error":
            with patch(
                "cybersoc_engine.pipeline.sha256_stream", side_effect=OSError("read failed")
            ):
                result = FileInspector().inspect(
                    str(path), ScanFileOptions(maxBytes=100), task_id="t"
                )
        else:
            result = FileInspector().inspect(str(path), ScanFileOptions(maxBytes=0), task_id="t")
    assert_trace(result)
    filetype.assert_not_called()
    assert result.layers[0].status == ("ERROR" if scenario == "hash_error" else "SKIPPED")
    assert result.layers[2].status == "SKIPPED"
    assert result.layers[2].reason == result.error.code
    assert result.evidence == []


def test_generated_fixtures_through_rpc_are_safe_and_unchanged():
    expected = {
        "pe_disfrazado.pdf": "TYPE_MISMATCH",
        "factura.pdf.exe": "DOUBLE_EXTENSION",
        "informe_\u202e.pdf": "RLO_IN_NAME",
    }
    with generate_fixtures(include_filetype=True) as root:
        assert len(list(root.rglob("*.*"))) == 28
        for name, code in expected.items():
            path = root / name
            before = path.read_bytes()
            modified = path.stat().st_mtime_ns
            if name == "pe_disfrazado.pdf":
                assert before == b"MZ" + b"Relleno inofensivo.\n" * 3
            else:
                assert before.startswith(b"Documento benigno")
            request = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "scan.file",
                "params": {
                    "jobId": "j",
                    "taskId": "t",
                    "path": str(path),
                    "options": {"maxBytes": 1000},
                },
            }
            reply = handle_line(json.dumps(request).encode())
            result = ScanFileResponse.model_validate_json(reply.response).result
            assert_trace(result)
            assert result.status == "SCANNED"
            assert [item.code for item in result.evidence] == [code]
            assert result.layers[2].hits == 1
            assert result.layers[2].points == 25
            assert path.read_bytes() == before
            assert path.stat().st_mtime_ns == modified
    assert not root.exists()


def test_rlo_or_dots_in_parent_directory_are_not_name_evidence(tmp_path):
    directory = tmp_path / "carpeta\u202e.pdf.exe"
    directory.mkdir()
    path = directory / "normal.txt"
    path.write_bytes(b"texto")
    result = FileInspector().inspect(str(path), ScanFileOptions(maxBytes=100), task_id="t")
    assert result.status == "SCANNED"
    assert result.evidence == []
    assert_trace(result)
