import sys
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, JsonValue, ValidationError

from cybersoc_engine.analysis.file_inspector import FileInspector
from cybersoc_engine.models import ScanFileParams
from cybersoc_engine.rpc.protocol import Request, RpcError
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
        "capabilities": [],
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


HANDLERS = {
    "engine.hello": hello,
    "engine.ping": ping,
    "engine.shutdown": shutdown,
    "scan.file": scan_file,
}


def dispatch(request: Request) -> dict[str, JsonValue]:
    handler = HANDLERS.get(request.method)
    if handler is None:
        raise RpcError(-32601)
    return handler(request.params)
