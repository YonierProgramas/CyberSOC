import json
from copy import deepcopy
from pathlib import Path

import pytest
from pydantic import ValidationError

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


def test_exactly_eight_shared_files():
    assert sorted(path.name for path in CONTRACTS.iterdir()) == sorted(MODELS)


@pytest.mark.parametrize("name,model", MODELS.items())
def test_shared_example(name, model):
    example = load(name)
    assert model.model_validate(example).model_dump() == example
    assert model.model_validate_json((CONTRACTS / name).read_bytes()).model_dump() == example


@pytest.mark.parametrize("name,path", FIELDS)
@pytest.mark.parametrize("change", ["delete", "type"])
def test_required_fields_reject_mutations(name, path, change):
    value = deepcopy(load(name))
    parent = value
    for key in path[:-1]:
        parent = parent[key]
    if change == "delete":
        del parent[path[-1]]
    else:
        parent[path[-1]] = True if path[-1] == "id" else None
    with pytest.raises(ValidationError):
        MODELS[name].model_validate(value)


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
