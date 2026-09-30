import json
import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError

type RequestId = str | int | float | None

ERROR_MESSAGES = {
    -32700: "Parse error",
    -32600: "Invalid Request",
    -32601: "Method not found",
    -32602: "Invalid params",
    -32603: "Internal error",
}


class RpcError(Exception):
    def __init__(self, code: int) -> None:
        self.code = code
        super().__init__(ERROR_MESSAGES[code])


class Request(BaseModel):
    model_config = ConfigDict(strict=True, extra="ignore", allow_inf_nan=False)

    jsonrpc: Literal["2.0"]
    method: str
    id: RequestId = None
    params: dict[str, JsonValue] | list[JsonValue] = Field(default_factory=dict)

    @property
    def is_notification(self) -> bool:
        return "id" not in self.model_fields_set


def _reject_constant(value: str) -> None:
    raise ValueError("Non-JSON numeric constant")


def _parse_finite_float(value: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Non-finite JSON number")
    return result


def parse_request(line: bytes) -> Request:
    try:
        value = json.loads(
            line.decode("utf-8"),
            parse_constant=_reject_constant,
            parse_float=_parse_finite_float,
        )
    except (ValueError, RecursionError) as error:
        raise RpcError(-32700) from error

    # This transport accepts one request object per line, not batch arrays.
    try:
        return Request.model_validate(value)
    except ValidationError as error:
        raise RpcError(-32600) from error


def encode_result(request_id: RequestId, result: dict[str, JsonValue]) -> str:
    return json.dumps(
        {"jsonrpc": "2.0", "id": request_id, "result": result},
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
    )


def encode_error(request_id: RequestId, code: int) -> str:
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": code, "message": ERROR_MESSAGES[code]},
        },
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
    )
