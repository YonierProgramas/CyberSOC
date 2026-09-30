import json

import pytest
from fixtures.generate import generate_fixtures

from cybersoc_engine.models import ScanFileResponse
from cybersoc_engine.rpc.server import handle_line


def request(path, **overrides):
    params = {"jobId": "j_1", "taskId": "t_1", "path": str(path), "options": {"maxBytes": 100}}
    params.update(overrides)
    return {"jsonrpc": "2.0", "id": 1, "method": "scan.file", "params": params}


def exchange(message):
    return json.loads(handle_line(json.dumps(message, ensure_ascii=False).encode("utf-8")).response)


def test_handler_success_and_contract(tmp_path):
    path = tmp_path / "niño_áéíóú_📄.txt"
    path.write_bytes(b"abc")
    response = exchange(request(path))
    result = ScanFileResponse.model_validate(response).result
    assert result.taskId == "t_1"
    assert result.status == "SCANNED"
    assert (
        result.hashes.sha256 == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
    assert result.evidence == []
    assert "error" not in response
    assert "error" not in response["result"]
    assert "verdict" not in response["result"]


def test_file_error_stays_inside_result(tmp_path):
    response = exchange(request(tmp_path / "missing.txt"))
    result = ScanFileResponse.model_validate(response).result
    assert result.status == "ERROR"
    assert result.error.code == "FILE_NOT_FOUND"
    assert "error" not in response
    assert "hashes" not in response["result"]


def test_handler_skips_oversize(tmp_path):
    path = tmp_path / "grande.txt"
    path.write_bytes(b"abc")
    result = ScanFileResponse.model_validate(
        exchange(request(path, options={"maxBytes": 2}))
    ).result
    assert result.status == "SKIPPED"
    assert result.error.code == "TOO_LARGE"


@pytest.mark.parametrize(
    "params",
    [
        {},
        [],
        {"jobId": "j", "taskId": "t", "path": "x"},
        {"jobId": "j", "taskId": "t", "path": 5, "options": {"maxBytes": 1}},
        {"jobId": "j", "taskId": "t", "path": "x", "options": {"maxBytes": "1"}},
    ],
)
def test_invalid_params_are_rpc_errors(params):
    response = exchange({"jsonrpc": "2.0", "id": 1, "method": "scan.file", "params": params})
    assert response["error"]["code"] == -32602
    assert "result" not in response


def test_fixtures_are_owned_temporary_text_files():
    with generate_fixtures() as root:
        paths = sorted(root.rglob("*.txt"))
        assert len(paths) == 25
        assert {len(path.relative_to(root).parts) for path in paths} == {1, 2, 3}
        assert all("ñ" in path.name and "ó" in path.name and "📄" in path.name for path in paths)
        assert all(
            path.read_text(encoding="utf-8").startswith("Documento benigno de prueba")
            for path in paths
        )
    assert not root.exists()
