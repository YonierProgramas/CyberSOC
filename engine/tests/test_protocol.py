import json

import pytest

from cybersoc_engine.rpc.protocol import RpcError, encode_error, encode_result, parse_request


@pytest.mark.parametrize("request_id", [1, 0, -7, 1.5, "hola-ñ-🔒", None])
def test_request_ids_round_trip(request_id):
    line = json.dumps(
        {"jsonrpc": "2.0", "id": request_id, "method": "engine.ping"}, ensure_ascii=False
    ).encode("utf-8")
    request = parse_request(line)
    assert not request.is_notification
    assert request.params == {}
    assert json.loads(encode_result(request.id, {"ok": True})) == {
        "jsonrpc": "2.0",
        "id": request_id,
        "result": {"ok": True},
    }


def test_notification_is_distinct_from_null_id():
    request = parse_request(b'{"jsonrpc":"2.0","method":"engine.ping"}\n')
    assert request.is_notification


@pytest.mark.parametrize(
    "line",
    [
        b"\n",
        b"{broken}\n",
        b"\xff\n",
        b"{} {}\n",
        b"NaN\n",
        b"Infinity\n",
        b'{"id":1e9999}\n',
        b'{"method":"engine.ping",}\n',
    ],
)
def test_parse_errors(line):
    with pytest.raises(RpcError) as error:
        parse_request(line)
    assert error.value.code == -32700


@pytest.mark.parametrize(
    "value",
    [
        None,
        [],
        [1],
        True,
        42,
        {},
        {"jsonrpc": "1.0", "method": "engine.ping"},
        {"jsonrpc": "2.0", "method": 1},
        {"jsonrpc": "2.0", "method": "engine.ping", "id": True},
        {"jsonrpc": "2.0", "method": "engine.ping", "id": []},
        {"jsonrpc": "2.0", "method": "engine.ping", "params": None},
        {"jsonrpc": "2.0", "method": "engine.ping", "params": "bad"},
    ],
)
def test_invalid_envelopes(value):
    with pytest.raises(RpcError) as error:
        parse_request(json.dumps(value).encode("utf-8"))
    assert error.value.code == -32600


def test_error_has_no_result_and_preserves_id():
    assert json.loads(encode_error("request-1", -32601)) == {
        "jsonrpc": "2.0",
        "id": "request-1",
        "error": {"code": -32601, "message": "Method not found"},
    }


def test_escaped_surrogate_id_can_be_encoded_safely():
    request = parse_request(b'{"jsonrpc":"2.0","id":"\\ud800","method":"engine.ping"}')
    response = encode_result(request.id, {"ok": True})
    assert json.loads(response.encode("utf-8"))["id"] == request.id
