import logging
from dataclasses import dataclass
from typing import BinaryIO, TextIO

from cybersoc_engine.rpc.handlers import dispatch
from cybersoc_engine.rpc.protocol import RpcError, encode_error, encode_result, parse_request

logger = logging.getLogger("cybersoc_engine.rpc")


@dataclass(frozen=True)
class LineResult:
    response: str | None
    shutdown: bool = False


def handle_line(line: bytes) -> LineResult:
    try:
        request = parse_request(line)
    except RpcError as error:
        logger.warning("RPC request rejected", extra={"rpc_code": error.code})
        return LineResult(encode_error(None, error.code))

    try:
        result = dispatch(request)
        response = None if request.is_notification else encode_result(request.id, result)
        return LineResult(response, shutdown=request.method == "engine.shutdown")
    except RpcError as error:
        logger.warning("RPC method rejected", extra={"rpc_code": error.code})
        code = error.code
    except Exception as error:
        logger.error("Internal RPC error", extra={"error_type": type(error).__name__})
        code = -32603

    return LineResult(None if request.is_notification else encode_error(request.id, code))


def serve(stdin: BinaryIO, stdout: TextIO) -> None:
    for line in stdin:
        result = handle_line(line)
        if result.response is not None:
            stdout.write(result.response + "\n")
            stdout.flush()
        if result.shutdown:
            return
