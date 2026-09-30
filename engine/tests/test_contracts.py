import json
from copy import deepcopy
from pathlib import Path

import pytest
from pydantic import ValidationError

from cybersoc_engine.models import (
    EngineResult,
    FileTask,
    ScanFileParams,
    ScanFileRequest,
    ScanFileResponse,
)
from cybersoc_engine.rpc.protocol import (
    HelloRequest,
    HelloResponse,
    MethodNotFoundResponse,
    ParseErrorResponse,
    PingRequest,
    PingResponse,
    ShutdownRequest,
    ShutdownResponse,
)
from cybersoc_engine.rpc.server import handle_line

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts" / "protocol-v1"
MODELS = {
    "engine.hello.request.json": HelloRequest,
    "engine.hello.response.json": HelloResponse,
    "engine.ping.request.json": PingRequest,
    "engine.ping.response.json": PingResponse,
    "engine.shutdown.request.json": ShutdownRequest,
    "engine.shutdown.response.json": ShutdownResponse,
    "error.method-not-found.json": MethodNotFoundResponse,
    "error.parse-error.json": ParseErrorResponse,
    "scan.file.request.json": ScanFileRequest,
    "scan.file.response.scanned.json": ScanFileResponse,
    "scan.file.response.error-access-denied.json": ScanFileResponse,
    "scan.file.response.skipped-cloud.json": ScanFileResponse,
    "scan.file.response.skipped-too-large.json": ScanFileResponse,
}


def load(name):
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


def field_paths(value, prefix=()):
    for key, child in value.items():
        path = (*prefix, key)
        yield path
        if isinstance(child, dict):
            yield from field_paths(child, path)


FIELDS = [(name, path) for name in MODELS for path in field_paths(load(name))]
MUTATIONS = [
    (name, path, change)
    for name, path in FIELDS
    for change in ("delete", "type")
    if not (
        change == "delete"
        and name.startswith("scan.file.response.")
        and path in (("result", "file"), ("result", "hashes"), ("result", "error"))
    )
]


def test_exactly_thirteen_shared_files():
    assert sorted(path.name for path in CONTRACTS.iterdir()) == sorted(MODELS)


@pytest.mark.parametrize("name,model", MODELS.items())
def test_shared_example(name, model):
    example = load(name)
    assert model.model_validate(example).model_dump(exclude_unset=True) == example
    assert (
        model.model_validate_json((CONTRACTS / name).read_bytes()).model_dump(exclude_unset=True)
        == example
    )


@pytest.mark.parametrize("name,path,change", MUTATIONS)
def test_required_fields_reject_mutations(name, path, change):
    value = deepcopy(load(name))
    parent = value
    for key in path[:-1]:
        parent = parent[key]
    if change == "delete":
        del parent[path[-1]]
    else:
        parent[path[-1]] = True if path[-1] in ("id", "extension") else None
    with pytest.raises(ValidationError):
        MODELS[name].model_validate(value)
    with pytest.raises(ValidationError):
        MODELS[name].model_validate_json(json.dumps(value))


@pytest.mark.parametrize("name,model", MODELS.items())
def test_wrong_jsonrpc_and_mixed_envelopes(name, model):
    example = load(name)
    with pytest.raises(ValidationError):
        model.model_validate({**example, "jsonrpc": "1.0"})
    extra = (
        {"error": {"code": -32603, "message": "Internal error"}}
        if "result" in example
        else {"result": {}}
    )
    with pytest.raises(ValidationError):
        model.model_validate({**example, **extra})


@pytest.mark.parametrize("method", ["engine.hello", "engine.ping", "engine.shutdown"])
def test_request_response_and_actual_handler(method):
    request = load(f"{method}.request.json")
    expected = load(f"{method}.response.json")
    assert request["id"] == expected["id"]
    actual = handle_line(json.dumps(request).encode("utf-8"))
    response = MODELS[f"{method}.response.json"].model_validate_json(actual.response)
    assert response.id == request["id"]
    assert actual.shutdown == (method == "engine.shutdown")


@pytest.mark.parametrize("protocol", [1, "2", 2])
def test_incompatible_protocol(protocol):
    request = load("engine.hello.request.json")
    request["params"]["protocol"] = protocol
    response = load("engine.hello.response.json")
    response["result"]["protocol"] = protocol
    with pytest.raises(ValidationError):
        HelloRequest.model_validate(request)
    with pytest.raises(ValidationError):
        HelloResponse.model_validate(response)


@pytest.mark.parametrize(
    "ts",
    [
        "2026-02-30T15:00:00Z",
        "2026-10-01",
        "2026-10-01T15:00:00",
        "2026-10-01T15:00:00+00:00",
        "2026-10-01T15:00Z",
        "2026-10-01T25:00:00Z",
    ],
)
def test_invalid_timestamp(ts):
    with pytest.raises(ValidationError):
        PingResponse.model_validate({**load("engine.ping.response.json"), "result": {"ts": ts}})


@pytest.mark.parametrize("ok", [False, 1, "true"])
def test_shutdown_requires_boolean_true(ok):
    with pytest.raises(ValidationError):
        ShutdownResponse.model_validate(
            {
                **load("engine.shutdown.response.json"),
                "result": {"ok": ok},
            }
        )


def test_invalid_methods_params_capabilities_and_codes():
    with pytest.raises(ValidationError):
        PingRequest.model_validate({**load("engine.ping.request.json"), "method": "unknown"})
    with pytest.raises(ValidationError):
        ShutdownRequest.model_validate(
            {
                **load("engine.shutdown.request.json"),
                "params": {"extra": 1},
            }
        )
    hello = load("engine.hello.response.json")
    hello["result"]["capabilities"] = [1]
    with pytest.raises(ValidationError):
        HelloResponse.model_validate(hello)
    with pytest.raises(ValidationError):
        MethodNotFoundResponse.model_validate(
            {
                **load("error.method-not-found.json"),
                "error": {"code": -32700, "message": "Parse error"},
            }
        )
    with pytest.raises(ValidationError):
        ParseErrorResponse.model_validate({**load("error.parse-error.json"), "id": 1})


@pytest.mark.parametrize(
    "name,line",
    [
        ("error.method-not-found.json", b'{"jsonrpc":"2.0","id":4,"method":"unknown"}'),
        ("error.parse-error.json", b"not-json"),
    ],
)
def test_actual_errors_match_shared_files(name, line):
    assert json.loads(handle_line(line).response) == load(name)


STATUSES = ["SCANNED", "ERROR", "SKIPPED"]
FILE_CODES = [
    "FILE_NOT_FOUND",
    "ACCESS_DENIED",
    "FILE_LOCKED",
    "IO_ERROR",
    "TOO_LARGE",
    "CLOUD_PLACEHOLDER",
    "TIMEOUT",
    "ENGINE_CRASHED",
]


def test_scan_correlation_unicode_and_evidence():
    request = ScanFileRequest.model_validate(load("scan.file.request.json"))
    response = ScanFileResponse.model_validate(load("scan.file.response.scanned.json"))
    assert response.id == request.id
    assert response.result.taskId == request.params.taskId
    assert "ñ" in response.result.file.name and "ó" in response.result.file.name
    assert request.params.path.endswith(response.result.file.name)
    assert response.result.evidence == []
    assert "verdict" not in response.result.model_dump()
    task = FileTask.model_validate(
        {
            "jobId": request.params.jobId,
            "taskId": request.params.taskId,
            "seq": 0,
            "path": request.params.path,
        }
    )
    assert task.path == request.params.path


@pytest.mark.parametrize(
    "suffix,status,code",
    [
        ("error-access-denied", "ERROR", "ACCESS_DENIED"),
        ("skipped-cloud", "SKIPPED", "CLOUD_PLACEHOLDER"),
        ("skipped-too-large", "SKIPPED", "TOO_LARGE"),
    ],
)
def test_file_errors_are_results(suffix, status, code):
    value = load(f"scan.file.response.{suffix}.json")
    result = ScanFileResponse.model_validate(value).result
    assert result.status == status
    assert result.error.code == code
    assert result.evidence == []
    assert "error" not in value


@pytest.mark.parametrize("status", STATUSES)
def test_optional_result_fields(status):
    value = {
        "taskId": "t_1",
        "status": status,
        "evidence": [],
        "durationMs": 0,
        "engineVersion": "0.1.0",
    }
    assert EngineResult.model_validate(value).model_dump(exclude_unset=True) == value


def test_nullable_extension():
    value = load("scan.file.response.scanned.json")["result"]
    value["file"]["extension"] = None
    assert EngineResult.model_validate(value).file.extension is None


@pytest.mark.parametrize("field", ["file", "hashes", "error"])
def test_optional_does_not_mean_nullable(field):
    value = load("scan.file.response.scanned.json")["result"]
    value[field] = None
    with pytest.raises(ValidationError):
        EngineResult.model_validate(value)


@pytest.mark.parametrize("code", FILE_CODES)
def test_file_error_codes(code):
    value = load("scan.file.response.scanned.json")["result"]
    value["error"] = {"code": code, "message": "Error de prueba"}
    assert EngineResult.model_validate(value).error.code == code


@pytest.mark.parametrize("status", ["CLEAN", "NOT_EVALUATED", "", 1, None])
def test_invalid_file_status(status):
    value = load("scan.file.response.scanned.json")["result"]
    value["status"] = status
    with pytest.raises(ValidationError):
        EngineResult.model_validate(value)


@pytest.mark.parametrize("code", ["UNKNOWN", -32603, None])
def test_invalid_file_error_code(code):
    value = load("scan.file.response.scanned.json")["result"]
    value["error"] = {"code": code, "message": "Error"}
    with pytest.raises(ValidationError):
        EngineResult.model_validate(value)


@pytest.mark.parametrize("sha256", ["<64 hex>", "a" * 63, "g" * 64, "a" * 65, "a" * 64 + "\n"])
def test_invalid_sha256(sha256):
    value = load("scan.file.response.scanned.json")["result"]
    value["hashes"]["sha256"] = sha256
    with pytest.raises(ValidationError):
        EngineResult.model_validate(value)


@pytest.mark.parametrize("value", [True, "512", None])
def test_scan_numeric_types_are_not_coerced(value):
    params = load("scan.file.request.json")["params"]
    params["options"]["maxBytes"] = value
    with pytest.raises(ValidationError):
        ScanFileParams.model_validate(params)
    result = load("scan.file.response.scanned.json")["result"]
    with pytest.raises(ValidationError):
        EngineResult.model_validate({**result, "durationMs": value})
    result["file"]["sizeBytes"] = value
    with pytest.raises(ValidationError):
        EngineResult.model_validate(result)


def test_unknown_scan_properties_and_method():
    request = load("scan.file.request.json")
    with pytest.raises(ValidationError):
        ScanFileRequest.model_validate({**request, "method": "scan.folder"})
    params = request["params"]
    params["options"]["layers"] = []
    with pytest.raises(ValidationError):
        ScanFileParams.model_validate(params)
    result = load("scan.file.response.scanned.json")["result"]
    with pytest.raises(ValidationError):
        EngineResult.model_validate({**result, "verdict": "CLEAN"})
    result["file"]["extra"] = True
    with pytest.raises(ValidationError):
        EngineResult.model_validate(result)
