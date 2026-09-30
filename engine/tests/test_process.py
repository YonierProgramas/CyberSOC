import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor


def engine_process(**kwargs):
    return subprocess.Popen(
        [sys.executable, "-m", "cybersoc_engine"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "PYTHONIOENCODING": "ascii:strict", "PYTHONUTF8": "0"},
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        **kwargs,
    )


def test_real_process_recovers_and_stdout_contains_only_json():
    lines = [
        b'{"jsonrpc":"2.0","id":1,"method":"engine.hello","params":{"protocol":"1"}}',
        b"not-json",
        b"\xff",
        b"{}",
        b'{"jsonrpc":"2.0","id":2,"method":"unknown"}',
        b'{"jsonrpc":"2.0","id":3,"method":"engine.hello","params":{"protocol":"2"}}',
        '{"jsonrpc":"2.0","id":"petición-🔒","method":"engine.ping"}'.encode(),
        b'{"jsonrpc":"2.0","method":"engine.ping"}',
        b'{"jsonrpc":"2.0","id":4,"method":"engine.shutdown"}',
        b'{"jsonrpc":"2.0","id":5,"method":"engine.ping"}',
    ]
    with engine_process() as process:
        stdout, stderr = process.communicate(b"\n".join(lines) + b"\n", timeout=10)
        assert process.returncode == 0
    assert b"\r" not in stdout
    responses = [json.loads(line) for line in stdout.decode("utf-8").splitlines()]
    assert len(responses) == 8
    assert all(response["jsonrpc"] == "2.0" for response in responses)
    assert responses[0]["result"]["protocol"] == "1"
    assert responses[0]["result"]["python"].startswith("3.12.")
    assert [response["error"]["code"] for response in responses[1:6]] == [
        -32700,
        -32700,
        -32600,
        -32601,
        -32602,
    ]
    assert responses[6]["id"] == "petición-🔒"
    assert responses[7] == {"jsonrpc": "2.0", "id": 4, "result": {"ok": True}}
    logs = [json.loads(line) for line in stderr.decode("utf-8").splitlines()]
    assert len(logs) >= 2
    assert all(log["component"] == "engine" for log in logs)
    assert logs[0]["message"] == "Engine started"
    assert logs[-1]["message"] == "Engine stopped"


def test_real_process_flushes_before_eof_and_shutdown_exits_with_stdin_open():
    with engine_process() as process, ThreadPoolExecutor(max_workers=1) as reader:
        try:
            process.stdin.write(b'{"jsonrpc":"2.0","id":1,"method":"engine.ping"}\n')
            process.stdin.flush()
            line = reader.submit(process.stdout.readline).result(timeout=5)
            assert json.loads(line)["id"] == 1
            assert not process.stdin.closed
            assert process.poll() is None

            process.stdin.write(b'{"jsonrpc":"2.0","id":2,"method":"engine.shutdown"}\n')
            process.stdin.flush()
            assert process.wait(timeout=5) == 0
            assert not process.stdin.closed
            assert json.loads(process.stdout.readline())["result"] == {"ok": True}
            assert process.stdout.read() == b""
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


def test_eof_ends_cleanly_without_protocol_output():
    with engine_process() as process:
        stdout, stderr = process.communicate(b"", timeout=10)
        assert process.returncode == 0
    assert stdout == b""
    assert all(json.loads(line)["component"] == "engine" for line in stderr.splitlines())
