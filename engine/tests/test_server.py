import io
import json
import logging

import pytest

from cybersoc_engine.logging_setup import configure_logging
from cybersoc_engine.rpc import server


def request(method="engine.ping", **fields):
    return json.dumps({"jsonrpc": "2.0", "method": method, **fields}).encode("utf-8") + b"\n"


@pytest.fixture
def log_stream():
    stream = io.StringIO()
    logger = logging.getLogger("cybersoc_engine")
    previous = logger.handlers[:], logger.level, logger.propagate
    configure_logging(stream)
    yield stream
    logger.handlers, logger.level, logger.propagate = previous


def test_invalid_shutdown_does_not_stop_server():
    stdin = io.BytesIO(request("engine.shutdown", id=1, params={"bad": True}) + request(id=2))
    stdout = io.StringIO()
    server.serve(stdin, stdout)
    responses = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert responses[0]["error"]["code"] == -32602
    assert responses[1]["id"] == 2
    assert "result" in responses[1]


@pytest.mark.parametrize(
    "method,params",
    [("engine.ping", {}), ("engine.unknown", {}), ("engine.hello", {"protocol": "2"})],
)
def test_notifications_do_not_respond_even_on_errors(method, params):
    result = server.handle_line(request(method, params=params))
    assert result.response is None
    assert not result.shutdown


def test_shutdown_notification_stops_without_response():
    result = server.handle_line(request("engine.shutdown"))
    assert result.response is None
    assert result.shutdown


def test_internal_error_is_sanitized_and_next_request_succeeds(monkeypatch, log_stream):
    real_dispatch = server.dispatch

    def fail_once(value):
        if value.id == 1:
            raise RuntimeError("sensitive diagnostic must not be emitted")
        return real_dispatch(value)

    monkeypatch.setattr(server, "dispatch", fail_once)
    stdout = io.StringIO()
    server.serve(io.BytesIO(request(id=1) + request(id=2)), stdout)
    responses = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert responses[0] == {
        "jsonrpc": "2.0",
        "id": 1,
        "error": {"code": -32603, "message": "Internal error"},
    }
    assert responses[1]["id"] == 2 and "result" in responses[1]
    log = json.loads(log_stream.getvalue())
    assert log["component"] == "engine" and log["error_type"] == "RuntimeError"
    assert "sensitive diagnostic" not in stdout.getvalue() + log_stream.getvalue()


def test_serialization_failure_becomes_internal_error(monkeypatch):
    monkeypatch.setattr(server, "dispatch", lambda _: {"invalid": object()})
    result = server.handle_line(request(id=7))
    assert json.loads(result.response)["error"]["code"] == -32603


def test_logging_is_one_json_line_and_does_not_echo_input(log_stream):
    server.handle_line(b"invalid input with confidential content\n")
    logs = [json.loads(line) for line in log_stream.getvalue().splitlines()]
    assert len(logs) == 1
    assert logs[0]["rpc_code"] == -32700
    assert logs[0]["timestamp"].endswith("Z")
    assert "confidential content" not in log_stream.getvalue()
