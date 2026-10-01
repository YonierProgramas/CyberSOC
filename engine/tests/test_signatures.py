import hashlib
import json
from unittest.mock import patch

import pytest
from fixtures.generate import generate_fixtures, generate_signature_fixtures
from pydantic import ValidationError
from test_process import engine_process

from cybersoc_engine.engines.base import AnalysisContext
from cybersoc_engine.engines.signature_engine import (
    DEFAULT_SIGNATURES,
    SignatureCatalog,
    SignatureEngine,
    default_catalog,
)
from cybersoc_engine.models import FileInfo, ScanFileResponse, StatsResponse
from cybersoc_engine.rpc.server import handle_line
from cybersoc_engine.version import ENGINE_VERSION

EICAR_HASH = "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f"


def context(sha256):
    return AnalysisContext(
        FileInfo(
            name="muestra.txt", extension=".txt", sizeBytes=0, modifiedAt="2026-09-30T00:00:00Z"
        ),
        b"",
        sha256,
    )


def request(path):
    return {
        "jsonrpc": "2.0",
        "id": 7,
        "method": "scan.file",
        "params": {"jobId": "j", "taskId": "t", "path": str(path), "options": {"maxBytes": 1024}},
    }


def rpc(message):
    return handle_line(json.dumps(message).encode())


def write_catalog(directory, *, name="test.json", sha256="a" * 64, signature_id="TEST", **changes):
    record = dict(id=signature_id, sha256=sha256, title="Firma inofensiva", testOnly=True)
    record.update(changes)
    path = directory / name
    path.write_text(json.dumps(dict(version="test-v1", signatures=[record])), encoding="utf-8")
    return path


def test_five_generated_text_fixtures_match_the_catalog(tmp_path):
    hashes = generate_signature_fixtures(tmp_path)
    catalog = SignatureCatalog()
    assert catalog.count == 6
    assert set(hashes) == {f"CSD-TEST-{i:03}" for i in range(1, 6)}
    for signature_id, sha256 in hashes.items():
        path = tmp_path / f"{signature_id}.txt"
        assert (
            path.read_text(encoding="utf-8")
            == f"CyberSOC Defender | {signature_id} | texto inofensivo de prueba.\n"
        )
        assert hashlib.sha256(path.read_bytes()).hexdigest() == sha256
        assert catalog.find(sha256).id == signature_id
        evidence = SignatureEngine(catalog).analyze(context(sha256))[0]
        assert evidence.source == "SIGNATURES"
        assert evidence.decisive is True
        assert evidence.confidence == 1
        assert evidence.severity == "CRITICAL" and evidence.points == 40
    assert generate_signature_fixtures(tmp_path) == hashes


def test_eicar_is_tested_only_by_published_hash():
    catalog = SignatureCatalog()
    record = catalog.find(EICAR_HASH)
    assert record.id == "EICAR-STANDARD"
    assert record.sourceUrl.startswith("https://knowledge.broadcom.com/")
    assert SignatureEngine(catalog).analyze(context(EICAR_HASH))[0].decisive is True
    # Solo el hash se usa en memoria; no se crea ni se descarga el archivo EICAR.


def test_no_match_and_changed_fixture(tmp_path):
    hashes = generate_signature_fixtures(tmp_path)
    engine = SignatureEngine(SignatureCatalog())
    assert engine.analyze(context("0" * 64)) == []
    assert engine.analyze(context(next(iter(hashes.values())).upper()))
    changed = (tmp_path / "CSD-TEST-001.txt").read_bytes() + b"Cambio inocuo.\n"
    assert engine.analyze(context(hashlib.sha256(changed).hexdigest())) == []


def test_multiple_files_case_normalization_and_content_version(tmp_path):
    first = write_catalog(tmp_path, name="a.json", sha256="A" * 64)
    write_catalog(tmp_path, name="b.json", sha256="b" * 64, signature_id="TEST-B")
    catalog = SignatureCatalog(tmp_path)
    assert catalog.count == 2
    assert catalog.find("a" * 64).sha256 == "a" * 64
    assert SignatureCatalog(tmp_path).version == catalog.version
    first.write_text(first.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    assert SignatureCatalog(tmp_path).version == catalog.version
    data = json.loads(first.read_text(encoding="utf-8"))
    data["signatures"][0]["title"] = "Título actualizado"
    first.write_text(json.dumps(data), encoding="utf-8")
    assert SignatureCatalog(tmp_path).version != catalog.version


@pytest.mark.parametrize(
    "changes",
    [
        {"sha256": "g" * 64},
        {"sha256": "a" * 63},
        {"id": ""},
        {"title": ""},
        {"testOnly": "true"},
        {"extra": 1},
    ],
)
def test_invalid_records_fail_instead_of_becoming_an_empty_catalog(tmp_path, changes):
    write_catalog(tmp_path, **changes)
    with pytest.raises(ValidationError):
        SignatureCatalog(tmp_path)


@pytest.mark.parametrize("kind", ["hash", "id", "json", "missing", "empty_version"])
def test_rejects_invalid_catalogs(tmp_path, kind):
    if kind == "missing":
        with pytest.raises(ValueError):
            SignatureCatalog(tmp_path)
        return
    path = write_catalog(tmp_path)
    if kind == "hash":
        write_catalog(tmp_path, name="duplicate.json", signature_id="OTHER", sha256="A" * 64)
    elif kind == "id":
        write_catalog(tmp_path, name="duplicate.json", sha256="b" * 64)
    elif kind == "json":
        path.write_text("not json", encoding="utf-8")
    else:
        path.write_text('{"version":"","signatures":[]}', encoding="utf-8")
    with pytest.raises(ValueError):
        SignatureCatalog(tmp_path)


def test_default_catalog_is_loaded_once_and_has_no_analysis_state():
    assert default_catalog() is default_catalog()
    assert default_catalog().count == 6


def test_stats_matches_loaded_catalog_and_announced_capability():
    message = {"jsonrpc": "2.0", "id": 9, "method": "engine.stats", "params": {}}
    result = StatsResponse.model_validate_json(rpc(message).response)
    assert result.id == 9
    assert result.result.engineVersion == ENGINE_VERSION
    assert result.result.signaturesCount == default_catalog().count == 6
    assert result.result.signaturesVersion == default_catalog().version
    hello = json.loads(
        rpc({**message, "method": "engine.hello", "params": {"protocol": "1"}}).response
    )
    assert "engine.stats" in hello["result"]["capabilities"]
    assert rpc({"jsonrpc": "2.0", "method": "engine.stats", "params": {}}).response is None


@pytest.mark.parametrize("params", [[], [1], {"extra": 1}])
def test_stats_rejects_noncanonical_parameters(params):
    response = json.loads(
        rpc({"jsonrpc": "2.0", "id": 1, "method": "engine.stats", "params": params}).response
    )
    assert response["error"]["code"] == -32602


def test_bad_catalog_is_layer_error_and_stats_rpc_error(tmp_path):
    path = tmp_path / "normal.txt"
    path.write_bytes(b"Texto benigno")
    with patch(
        "cybersoc_engine.engines.signature_engine.default_catalog",
        side_effect=ValueError("bad catalog"),
    ):
        result = ScanFileResponse.model_validate_json(rpc(request(path)).response).result
    assert result.verdict == "ERROR" and result.score is None and result.riskLevel is None
    assert [layer.status for layer in result.layers] == [
        "RAN",
        "ERROR",
        "RAN",
        "RAN",
        "RAN",
        "SKIPPED",
        "SKIPPED",
    ]
    with patch(
        "cybersoc_engine.rpc.handlers.default_catalog", side_effect=ValueError("bad catalog")
    ):
        response = rpc({"jsonrpc": "2.0", "id": 1, "method": "engine.stats", "params": {}})
    assert json.loads(response.response)["error"]["code"] == -32603
    assert "bad catalog" not in response.response


def test_signature_survives_filetype_failure(tmp_path):
    generate_signature_fixtures(tmp_path)
    with patch(
        "cybersoc_engine.engines.filetype_engine.FileTypeEngine.analyze",
        side_effect=RuntimeError("test"),
    ):
        result = ScanFileResponse.model_validate_json(
            rpc(request(tmp_path / "CSD-TEST-001.txt")).response
        ).result
    assert result.status == "ERROR"
    assert (result.verdict, result.score, result.riskLevel) == ("DETECTED", 85, "CRÍTICO")


def test_real_process_detects_five_fixtures_and_reports_same_catalog():
    with generate_fixtures(include_signatures=True) as root:
        paths = sorted(root.glob("CSD-TEST-*.txt"))
        assert len(paths) == 5
        snapshots = [(path.read_bytes(), path.stat().st_mtime_ns) for path in paths]
        messages = [{"jsonrpc": "2.0", "id": 1, "method": "engine.stats", "params": {}}]
        messages.extend(request(path) for path in paths)
        messages.append({"jsonrpc": "2.0", "id": 99, "method": "engine.shutdown", "params": {}})
        with engine_process(cwd=DEFAULT_SIGNATURES) as process:
            stdout, stderr = process.communicate(
                ("\n".join(map(json.dumps, messages)) + "\n").encode(), timeout=15
            )
            assert process.returncode == 0, stderr.decode()
        responses = [json.loads(line) for line in stdout.splitlines()]
        assert len(responses) == 7
        stats = StatsResponse.model_validate(responses[0]).result
        for path, before, response in zip(paths, snapshots, responses[1:6], strict=True):
            result = ScanFileResponse.model_validate(response).result
            assert result.status == "SCANNED"
            assert (result.verdict, result.score, result.riskLevel) == ("DETECTED", 85, "CRÍTICO")
            assert [layer.layer for layer in result.layers] == [
                "HASH",
                "SIGNATURES",
                "FILETYPE",
                "RULES",
                "HEURISTICS",
                "PE",
                "SCRIPTS",
            ]
            assert result.layers[1].hits == 1 and result.layers[1].points == 40
            assert result.evidence[0].facts["signaturesVersion"] == stats.signaturesVersion
            assert result.evidence[0].facts["signatureId"] == path.stem
            assert (path.read_bytes(), path.stat().st_mtime_ns) == before
        assert stats.signaturesCount == 6
