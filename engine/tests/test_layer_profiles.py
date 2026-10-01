import hashlib
import json
from unittest.mock import patch

import pytest
from fixtures.generate import generate_signature_fixtures
from pydantic import ValidationError

from cybersoc_engine.engines.filetype_engine import FileTypeEngine
from cybersoc_engine.models import LayerTrace, ScanFileOptions, ScanFileResponse
from cybersoc_engine.rpc.server import handle_line


def scan(path, **options):
    request = {
        "jsonrpc": "2.0",
        "id": 77,
        "method": "scan.file",
        "params": {
            "jobId": "j",
            "taskId": "t",
            "path": str(path),
            "options": {"maxBytes": 1024, **options},
        },
    }
    return json.loads(handle_line(json.dumps(request).encode()).response)


@pytest.mark.parametrize(
    "zone",
    [
        "DESCARGAS",
        "ESCRITORIO",
        "DOCUMENTOS",
        "TEMPORALES",
        "DATOS_APPS",
        "EXTRAIBLE",
        "PROGRAMAS",
        "SISTEMA",
        "OTRA",
    ],
)
def test_zone_roundtrip(zone):
    options = {"maxBytes": 1, "zone": zone}
    assert ScanFileOptions.model_validate(options).model_dump(exclude_unset=True) == options


@pytest.mark.parametrize(
    "options",
    [
        {"zone": None},
        {"zone": "SYSTEM"},
        {"zone": 1},
        {"zone": ""},
        {"layers": None},
        {"layers": "HASH"},
        {"layers": ["OTHER"]},
        {"layers": [1]},
        {"layers": ["HASH", "HASH"]},
        {"layers": ["ENGINE"]},
    ],
)
def test_invalid_options_rejected_by_model_and_rpc(options):
    with pytest.raises(ValidationError):
        ScanFileOptions.model_validate({"maxBytes": 1, **options})
    assert scan("missing.txt", **options)["error"]["code"] == -32602


@pytest.mark.parametrize(
    "layers", [[], ["HASH"], ["SIGNATURES"], ["RULES", "PE", "SCRIPTS", "HEURISTICS"]]
)
def test_excluded_filetype_not_called_and_mandatory_layers_detect(tmp_path, layers):
    generate_signature_fixtures(tmp_path)
    path = tmp_path / "CSD-TEST-001.txt"
    before = path.read_bytes()
    with patch.object(
        FileTypeEngine, "analyze", side_effect=AssertionError("disabled")
    ) as filetype:
        result = ScanFileResponse.model_validate(scan(path, zone="SISTEMA", layers=layers)).result
    filetype.assert_not_called()
    assert result.verdict == "DETECTED"
    assert result.hashes.sha256 == hashlib.sha256(before).hexdigest()
    assert [e.source for e in result.evidence] == ["SIGNATURES"]
    assert [e.id for e in result.evidence] == ["ev1"]
    assert [(t.layer, t.status) for t in result.layers] == [
        ("HASH", "RAN"),
        ("SIGNATURES", "RAN"),
        ("FILETYPE", "DISABLED"),
        ("RULES", "RAN" if "RULES" in layers else "DISABLED"),
    ]
    disabled = result.layers[2]
    assert disabled.reason == "PROFILE_DISABLED"
    assert disabled.hits == disabled.points == disabled.ms == 0
    assert path.read_bytes() == before


@pytest.mark.parametrize(
    "options",
    [
        {},
        {"zone": "SISTEMA"},
        {"layers": ["FILETYPE"]},
        {"layers": ["FILETYPE", "SIGNATURES", "HASH"]},
    ],
)
def test_legacy_or_enabled_layers_run_in_canonical_order(tmp_path, options):
    path = tmp_path / "factura.pdf.exe"
    path.write_bytes(b"texto benigno")
    result = ScanFileResponse.model_validate(scan(path, **options)).result
    assert [(t.layer, t.status) for t in result.layers] == [
        ("HASH", "RAN"),
        ("SIGNATURES", "RAN"),
        ("FILETYPE", "RAN"),
        ("RULES", "RAN" if "layers" not in options else "DISABLED"),
    ]
    assert [e.code for e in result.evidence] == ["DOUBLE_EXTENSION"]


@pytest.mark.parametrize("scenario", ["missing", "too_large", "hash_error"])
def test_disabled_trace_even_when_file_not_analyzed(tmp_path, scenario):
    path = tmp_path / "factura.pdf.exe"
    if scenario != "missing":
        path.write_bytes(b"texto benigno")
    with patch("cybersoc_engine.pipeline.consume_stream", side_effect=OSError("private path")):
        response = scan(path, layers=[], maxBytes=0 if scenario == "too_large" else 1024)
    result = ScanFileResponse.model_validate(response).result
    assert [t.layer for t in result.layers] == ["HASH", "SIGNATURES", "FILETYPE", "RULES"]
    assert result.layers[0].status == ("ERROR" if scenario == "hash_error" else "SKIPPED")
    assert result.layers[1].status == "SKIPPED"
    assert result.layers[1].reason
    assert result.layers[2].status == "DISABLED"
    assert result.layers[2].reason == "PROFILE_DISABLED"
    assert result.evidence == []


@pytest.mark.parametrize(
    "change",
    [
        {"layer": "HASH"},
        {"layer": "SIGNATURES"},
        {"reason": None},
        {"reason": " "},
        {"hits": 1},
        {"points": 1},
    ],
)
def test_disabled_invariants(change):
    trace = {
        "layer": "FILETYPE",
        "status": "DISABLED",
        "reason": "PROFILE_DISABLED",
        "hits": 0,
        "points": 0,
        "ms": 0,
    }
    with pytest.raises(ValidationError):
        LayerTrace.model_validate({**trace, **change})
