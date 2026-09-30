import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fixtures.generate import generate_fixtures

from cybersoc_engine.models import ScanFileResponse


def engine_process(**kwargs):
    return subprocess.Popen(
        [sys.executable, "-m", "cybersoc_engine"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            **os.environ,
            # Match pytest's src import path in the isolated child interpreter.
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
            "PYTHONIOENCODING": "ascii:strict",
            "PYTHONUTF8": "0",
        },
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


def test_process_scans_twenty_five_unicode_files_and_continues_after_file_error():
    import hashlib

    with generate_fixtures() as root:
        paths = sorted(root.rglob("*.txt"))
        snapshots = [
            (path.stat().st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
            for path in paths
        ]
        messages = [
            {
                "jsonrpc": "2.0",
                "id": index,
                "method": "scan.file",
                "params": {
                    "jobId": "j_1",
                    "taskId": f"t_{index}",
                    "path": str(path),
                    "options": {"maxBytes": 1024},
                },
            }
            for index, path in enumerate(paths, 1)
        ]
        messages.extend(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 26,
                    "method": "scan.file",
                    "params": {
                        "jobId": "j_1",
                        "taskId": "t_26",
                        "path": str(root / "missing.txt"),
                        "options": {"maxBytes": 1024},
                    },
                },
                {"jsonrpc": "2.0", "id": 27, "method": "scan.file", "params": {}},
                {"jsonrpc": "2.0", "id": 28, "method": "engine.ping", "params": {}},
                {"jsonrpc": "2.0", "id": 29, "method": "engine.shutdown", "params": {}},
            ]
        )
        lines = "".join(json.dumps(message, ensure_ascii=False) + "\n" for message in messages)
        with engine_process() as process:
            stdout, stderr = process.communicate(lines.encode("utf-8"), timeout=15)
            assert process.returncode == 0, stderr.decode("utf-8")
        responses = [json.loads(line) for line in stdout.decode("utf-8").splitlines()]
        assert len(responses) == 29
        for index, (path, before) in enumerate(zip(paths, snapshots, strict=True)):
            response = ScanFileResponse.model_validate(responses[index])
            assert response.id == index + 1
            assert response.result.taskId == f"t_{index + 1}"
            assert response.result.status == "SCANNED"
            assert response.result.hashes.sha256 == before[1]
            assert response.result.file.name == path.name
            assert response.result.evidence == []
            assert path.stat().st_mtime_ns == before[0]
            assert hashlib.sha256(path.read_bytes()).hexdigest() == before[1]
        assert responses[25]["result"]["error"]["code"] == "FILE_NOT_FOUND"
        assert responses[26]["error"]["code"] == -32602
        assert responses[27]["result"]["ts"]
        assert responses[28]["result"] == {"ok": True}
        assert all(json.loads(line)["component"] == "engine" for line in stderr.splitlines())
