import sys
from datetime import UTC, datetime

import pytest

from cybersoc_engine.rpc.handlers import dispatch, hello, ping, shutdown
from cybersoc_engine.rpc.protocol import Request, RpcError


def test_hello_matches_the_sprint_protocol():
    assert hello({"protocol": "1", "client": "cybersoc-core/0.0.1"}) == {
        "protocol": "1",
        "engineVersion": "0.0.1",
        "python": ".".join(str(part) for part in sys.version_info[:3]),
        "capabilities": ["scan.file", "engine.stats", "fs.driveInfo", "rules.reload"],
    }


@pytest.mark.parametrize(
    "params",
    [{}, {"protocol": "2"}, {"protocol": 1}, {"protocol": None}, {"protocol": True}, ["1"]],
)
def test_hello_requires_protocol_string_one(params):
    with pytest.raises(RpcError) as error:
        hello(params)
    assert error.value.code == -32602


def test_ping_returns_current_utc_iso_timestamp():
    before = datetime.now(UTC)
    result = ping({})
    after = datetime.now(UTC)
    timestamp = datetime.fromisoformat(result["ts"])
    assert result["ts"].endswith("Z")
    assert before.replace(microsecond=before.microsecond // 1000 * 1000) <= timestamp <= after


@pytest.mark.parametrize("params", [{}, []])
def test_shutdown_accepts_empty_parameters(params):
    assert shutdown(params) == {"ok": True}


@pytest.mark.parametrize("handler", [ping, shutdown])
@pytest.mark.parametrize("params", [{"unexpected": True}, [1]])
def test_parameterless_methods_reject_arguments(handler, params):
    with pytest.raises(RpcError) as error:
        handler(params)
    assert error.value.code == -32602


def test_unknown_method():
    request = Request(jsonrpc="2.0", id=9, method="engine.unknown")
    with pytest.raises(RpcError) as error:
        dispatch(request)
    assert error.value.code == -32601
