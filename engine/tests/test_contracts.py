import json
from copy import deepcopy
from pathlib import Path

import pytest
from pydantic import ValidationError

from cybersoc_engine.models import (
    DriveInfoRequest,
    DriveInfoResponse,
    EngineResult,
    FileTask,
    RulesReloadRequest,
    RulesReloadResponse,
    ScanFileParams,
    ScanFileRequest,
    ScanFileResponse,
    StatsRequest,
    StatsResponse,
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
    "scan.file.request.zone-layers.json": ScanFileRequest,
    "scan.file.request.mandatory-only.json": ScanFileRequest,
    "scan.file.response.disabled-layers.json": ScanFileResponse,
    "fs.driveInfo.request.json": DriveInfoRequest,
    "fs.driveInfo.response.json": DriveInfoResponse,
    "scan.file.request.json": ScanFileRequest,
    "scan.file.response.scanned.json": ScanFileResponse,
    "scan.file.response.error-access-denied.json": ScanFileResponse,
    "scan.file.response.skipped-cloud.json": ScanFileResponse,
    "scan.file.response.skipped-too-large.json": ScanFileResponse,
    "scan.file.response.detected-signature.json": ScanFileResponse,
    "scan.file.response.double-extension.json": ScanFileResponse,
    "rules.reload.request.json": RulesReloadRequest,
    "rules.reload.response.json": RulesReloadResponse,
    "engine.stats.request.json": StatsRequest,
    "engine.stats.response.json": StatsResponse,
}


def load(name):
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


def field_paths(value, prefix=()):
    for key, child in value.items():
        path = (*prefix, key)
        yield path
        # facts es un diccionario abierto: sus claves particulares no son obligatorias.
        if key == "facts":
            continue
        if isinstance(child, dict):
            yield from field_paths(child, path)
        elif isinstance(child, list):
            for index, item in enumerate(child):
                if isinstance(item, dict):
                    yield from field_paths(item, (*path, index))


FIELDS = [(name, path) for name in MODELS for path in field_paths(load(name))]
MUTATIONS = [
    (name, path, change)
    for name, path in FIELDS
    for change in ("delete", "type")
    if not (
        change == "delete"
        and (
            (
                name.startswith("scan.file.response.")
                and path in (("result", "file"), ("result", "hashes"), ("result", "error"))
            )
            or path in (("params", "options", "zone"), ("params", "options", "layers"))
        )
    )
]


def test_all_shared_files_have_a_model():
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
        parent[path[-1]] = True if path[-1] in ("id", "extension", "score", "riskLevel") else None
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
    assert "verdict" not in response.result.model_dump(exclude_unset=True)
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
        "layers": [],
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
    params["options"]["unknownOption"] = []
    with pytest.raises(ValidationError):
        ScanFileParams.model_validate(params)
    result = load("scan.file.response.scanned.json")["result"]
    with pytest.raises(ValidationError):
        EngineResult.model_validate({**result, "verdict": "CLEAN"})
    result["file"]["extra"] = True
    with pytest.raises(ValidationError):
        EngineResult.model_validate(result)


@pytest.mark.parametrize(
    "field,value",
    [
        ("id", "ev0"),
        ("id", "ev1\n"),
        ("source", "HASH"),
        ("source", "UNKNOWN"),
        ("severity", "SEVERE"),
        ("code", ""),
        ("title", ""),
        ("points", -1),
        ("points", 1.5),
        ("points", "25"),
        ("points", True),
        ("points", 9007199254740992),
        ("confidence", -0.01),
        ("confidence", 1.01),
        ("confidence", "0.8"),
        ("confidence", True),
        ("confidence", float("inf")),
        ("decisive", 1),
        ("decisive", "false"),
        ("facts", []),
        ("facts", "text"),
        ("extra", 1),
    ],
)
def test_invalid_evidence(field, value):
    response = load("scan.file.response.double-extension.json")
    response["result"]["evidence"][0][field] = value
    with pytest.raises(ValidationError):
        ScanFileResponse.model_validate(response)


@pytest.mark.parametrize(
    "source", ["SIGNATURES", "FILETYPE", "RULES", "HEURISTICS", "PE", "SCRIPTS", "ENGINE"]
)
def test_evidence_sources(source):
    response = load("scan.file.response.double-extension.json")
    response["result"]["evidence"][0]["source"] = source
    ScanFileResponse.model_validate(response)


@pytest.mark.parametrize("severity", ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"])
def test_evidence_severities(severity):
    response = load("scan.file.response.double-extension.json")
    response["result"]["evidence"][0]["severity"] = severity
    ScanFileResponse.model_validate(response)


@pytest.mark.parametrize("confidence", [0, 1])
@pytest.mark.parametrize("facts", [{}, {"nested": {"values": [None, True, 2, "texto"]}}])
def test_json_facts_and_confidence_boundaries(confidence, facts):
    response = load("scan.file.response.double-extension.json")
    response["result"]["evidence"][0].update(confidence=confidence, facts=facts)
    assert ScanFileResponse.model_validate(response).model_dump(exclude_unset=True) == response


@pytest.mark.parametrize(
    "field,value",
    [
        ("layer", "ENGINE"),
        ("layer", "UNKNOWN"),
        ("status", "DONE"),
        ("hits", -1),
        ("hits", 0.5),
        ("hits", True),
        ("hits", "1"),
        ("points", -1),
        ("points", 0.5),
        ("points", True),
        ("points", "25"),
        ("ms", -1),
        ("ms", True),
        ("ms", "1"),
        ("ms", float("inf")),
        ("reason", None),
        ("reason", ""),
        ("reason", "   "),
        ("extra", 1),
    ],
)
def test_invalid_layer(field, value):
    response = load("scan.file.response.double-extension.json")
    response["result"]["layers"][2][field] = value
    with pytest.raises(ValidationError):
        ScanFileResponse.model_validate(response)


@pytest.mark.parametrize(
    "layer", ["HASH", "SIGNATURES", "FILETYPE", "RULES", "HEURISTICS", "PE", "SCRIPTS"]
)
def test_all_layer_names(layer):
    response = load("scan.file.response.double-extension.json")
    response["result"]["layers"] = [dict(layer=layer, status="RAN", hits=0, points=0, ms=0)]
    ScanFileResponse.model_validate(response)


@pytest.mark.parametrize("status", ["RAN", "SKIPPED", "DISABLED", "ERROR"])
def test_layer_status_and_optional_reason(status):
    response = load("scan.file.response.double-extension.json")
    trace = response["result"]["layers"][2]
    trace.update(status=status, reason="NOT_APPLICABLE", ms=0 if status == "DISABLED" else 0.25)
    if status == "DISABLED":
        trace.update(hits=0, points=0)
    ScanFileResponse.model_validate(response)
    del trace["reason"]
    if status in ("SKIPPED", "DISABLED"):
        with pytest.raises(ValidationError):
            ScanFileResponse.model_validate(response)
    else:
        ScanFileResponse.model_validate(response)


@pytest.mark.parametrize("mutation", ["duplicate", "disable_hash"])
def test_layer_invariants(mutation):
    response = load("scan.file.response.double-extension.json")
    layers = response["result"]["layers"]
    if mutation == "duplicate":
        layers.append(deepcopy(layers[0]))
    else:
        layers[0]["status"] = "DISABLED"
    with pytest.raises(ValidationError):
        ScanFileResponse.model_validate(response)


@pytest.mark.parametrize("count", [-1, 1.5, True, "5", None, 9007199254740992])
def test_invalid_signatures_count(count):
    value = load("engine.stats.response.json")
    value["result"]["signaturesCount"] = count
    with pytest.raises(ValidationError):
        StatsResponse.model_validate(value)


def test_stats_zero_versions_method_and_params():
    value = load("engine.stats.response.json")
    value["result"]["signaturesCount"] = 0
    StatsResponse.model_validate(value)
    for field in ("engineVersion", "signaturesVersion", "rulesetVersion"):
        invalid = deepcopy(value)
        invalid["result"][field] = ""
        with pytest.raises(ValidationError):
            StatsResponse.model_validate(invalid)
    request = load("engine.stats.request.json")
    assert request["id"] == value["id"]
    with pytest.raises(ValidationError):
        StatsRequest.model_validate({**request, "method": "stats"})
    with pytest.raises(ValidationError):
        StatsRequest.model_validate({**request, "params": {"extra": True}})


def test_decisive_signature_and_non_decisive_heuristic():
    signature = ScanFileResponse.model_validate(load("scan.file.response.detected-signature.json"))
    heuristic = ScanFileResponse.model_validate(load("scan.file.response.double-extension.json"))
    assert signature.result.evidence[0].decisive is True
    assert signature.result.evidence[0].source == "SIGNATURES"
    assert heuristic.result.evidence[0].decisive is False
    assert heuristic.result.evidence[0].points == 25
    assert heuristic.result.verdict == "CLEAN"


@pytest.mark.parametrize("scenario", ["scanned", "skipped", "missing", "read_error"])
def test_current_inspector_emits_valid_hash_trace(tmp_path, scenario):
    from unittest.mock import patch

    from cybersoc_engine.analysis.file_inspector import FileInspector
    from cybersoc_engine.models import ScanFileOptions

    path = tmp_path / "inofensivo.txt"
    if scenario != "missing":
        path.write_text("Texto inofensivo de prueba.", encoding="utf-8")
    with patch("cybersoc_engine.pipeline.consume_stream") as hashing:
        hashing.return_value = 0
        if scenario == "read_error":
            hashing.side_effect = OSError("read failed")
        result = FileInspector().inspect(
            str(path),
            ScanFileOptions(maxBytes=0 if scenario == "skipped" else 1024),
            task_id="t_trace",
        )
    wire = result.model_dump(exclude_unset=True)
    EngineResult.model_validate(wire)
    assert [layer.layer for layer in result.layers] == ["HASH", "SIGNATURES", "FILETYPE", "RULES"]
    trace = result.layers[0]
    assert trace.layer == "HASH"
    assert (
        trace.status
        == {"scanned": "RAN", "skipped": "SKIPPED", "missing": "SKIPPED", "read_error": "ERROR"}[
            scenario
        ]
    )
    assert trace.ms >= 0
    if trace.status != "RAN":
        assert trace.reason == result.error.code


@pytest.mark.parametrize("count", [0, 1.0, 9007199254740991])
def test_json_integer_representations(count):
    value = load("engine.stats.response.json")
    value["result"]["signaturesCount"] = count
    assert StatsResponse.model_validate(value).result.signaturesCount == count
    assert StatsResponse.model_validate_json(json.dumps(value)).result.signaturesCount == count
    response = load("scan.file.response.double-extension.json")
    response["result"]["evidence"][0]["points"] = count
    response["result"]["layers"][2].update(hits=count, points=count)
    ScanFileResponse.model_validate_json(json.dumps(response))


@pytest.mark.parametrize(
    "verdict,score,level",
    [
        ("CLEAN", 0, "BAJO"),
        ("CLEAN", 29, "BAJO"),
        ("SUSPICIOUS", 30, "MEDIO"),
        ("SUSPICIOUS", 59, "MEDIO"),
        ("SUSPICIOUS", 60, "ALTO"),
        ("SUSPICIOUS", 84, "ALTO"),
        ("SUSPICIOUS", 85, "CRÍTICO"),
        ("DETECTED", 85, "CRÍTICO"),
        ("DETECTED", 100, "CRÍTICO"),
        ("ERROR", None, None),
        ("NOT_ANALYZED", None, None),
    ],
)
def test_valid_risk_assessment_contract(verdict, score, level):
    value = load("scan.file.response.scanned.json")["result"]
    value.update(verdict=verdict, score=score, riskLevel=level)
    assert EngineResult.model_validate(value).model_dump(exclude_unset=True) == value
    EngineResult.model_validate_json(json.dumps(value))


@pytest.mark.parametrize(
    "verdict,score,level",
    [
        ("CLEAN", None, None),
        ("CLEAN", 30, "MEDIO"),
        ("SUSPICIOUS", 29, "BAJO"),
        ("DETECTED", 84, "ALTO"),
        ("CLEAN", 0, "MEDIO"),
        ("DETECTED", 85, "ALTO"),
        ("ERROR", 0, "BAJO"),
        ("NOT_ANALYZED", 0, "BAJO"),
        ("CLEAN", 1.5, "BAJO"),
        ("CLEAN", -1, "BAJO"),
        ("DETECTED", 101, "CRÍTICO"),
        ("CLEAN", True, "BAJO"),
        ("CLEAN", "0", "BAJO"),
        ("CLEAN", float("inf"), "BAJO"),
        (None, None, None),
        ("UNKNOWN", 0, "BAJO"),
        ("DETECTED", 85, "CRITICO"),
    ],
)
def test_invalid_risk_assessment_contract(verdict, score, level):
    value = load("scan.file.response.scanned.json")["result"]
    value.update(verdict=verdict, score=score, riskLevel=level)
    with pytest.raises(ValidationError):
        EngineResult.model_validate(value)
    with pytest.raises(ValidationError):
        EngineResult.model_validate_json(json.dumps(value))


@pytest.mark.parametrize("field", ["verdict", "score", "riskLevel"])
def test_partial_risk_assessment_rejected(field):
    value = load("scan.file.response.double-extension.json")["result"]
    del value[field]
    with pytest.raises(ValidationError):
        EngineResult.model_validate(value)
