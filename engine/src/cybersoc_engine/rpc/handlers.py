import logging
import sys
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, JsonValue, ValidationError

from cybersoc_engine.analysis.drive_info import drive_type
from cybersoc_engine.analysis.file_inspector import FileInspector
from cybersoc_engine.engines.rule_engine import RuleConfigError, default_rules
from cybersoc_engine.engines.signature_engine import default_catalog
from cybersoc_engine.models import (
    DriveInfoParams,
    DriveInfoResult,
    RulesReloadResult,
    ScanFileParams,
    StatsResult,
)
from cybersoc_engine.rpc.protocol import EmptyParams, Request, RpcError
from cybersoc_engine.version import ENGINE_VERSION, PROTOCOL_VERSION


class HelloParams(BaseModel):
    model_config = ConfigDict(strict=True, extra="ignore")

    protocol: Literal["1"]


def hello(params: dict[str, JsonValue] | list[JsonValue]) -> dict[str, JsonValue]:
    try:
        HelloParams.model_validate(params)
    except ValidationError as error:
        raise RpcError(-32602) from error

    return {
        "protocol": PROTOCOL_VERSION,
        "engineVersion": ENGINE_VERSION,
        "python": ".".join(str(part) for part in sys.version_info[:3]),
        "capabilities": ["scan.file", "engine.stats", "fs.driveInfo", "rules.reload"],
    }


def _require_empty_params(params: dict[str, JsonValue] | list[JsonValue]) -> None:
    if params != {} and params != []:
        raise RpcError(-32602)


def ping(params: dict[str, JsonValue] | list[JsonValue]) -> dict[str, JsonValue]:
    _require_empty_params(params)
    return {"ts": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")}


def shutdown(params: dict[str, JsonValue] | list[JsonValue]) -> dict[str, JsonValue]:
    _require_empty_params(params)
    return {"ok": True}


def scan_file(params: dict[str, JsonValue] | list[JsonValue]) -> dict[str, JsonValue]:
    try:
        request = ScanFileParams.model_validate(params)
    except ValidationError as error:
        raise RpcError(-32602) from error
    result = FileInspector().inspect(request.path, request.options, task_id=request.taskId)
    return result.model_dump(mode="json", exclude_unset=True)


def stats(params: dict[str, JsonValue] | list[JsonValue]) -> dict[str, JsonValue]:
    try:
        EmptyParams.model_validate(params)
    except ValidationError as error:
        raise RpcError(-32602) from error
    catalog = default_catalog()
    return StatsResult(
        engineVersion=ENGINE_VERSION,
        signaturesVersion=catalog.version,
        signaturesCount=catalog.count,
        rulesetVersion=default_rules.current().version,
    ).model_dump(mode="json")


def rules_reload(params: dict[str, JsonValue] | list[JsonValue]) -> dict[str, JsonValue]:
    try:
        EmptyParams.model_validate(params)
    except ValidationError as error:
        raise RpcError(-32602) from error
    try:
        catalog = default_rules.reload()
    except RuleConfigError as error:
        # Detalle de configuración local por stderr; stdout permanece JSON-RPC.
        logging.getLogger(__name__).error("Recarga de reglas rechazada: %s", error)
        raise RpcError(-32603) from error
    return RulesReloadResult(
        rulesetVersion=catalog.version, rulesCount=len(catalog.rules)
    ).model_dump(mode="json")


def drive_info(params: dict[str, JsonValue] | list[JsonValue]) -> dict[str, JsonValue]:
    try:
        request = DriveInfoParams.model_validate(params)
    except ValidationError as error:
        raise RpcError(-32602) from error
    return DriveInfoResult(driveType=drive_type(request.path)).model_dump(mode="json")


HANDLERS = {
    "engine.hello": hello,
    "engine.ping": ping,
    "engine.shutdown": shutdown,
    "scan.file": scan_file,
    "engine.stats": stats,
    "fs.driveInfo": drive_info,
    "rules.reload": rules_reload,
}


def dispatch(request: Request) -> dict[str, JsonValue]:
    handler = HANDLERS.get(request.method)
    if handler is None:
        raise RpcError(-32601)
    return handler(request.params)
