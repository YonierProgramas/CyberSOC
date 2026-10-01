import json
import sys
from ctypes import wintypes
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
from pydantic import ValidationError
from test_process import engine_process

from cybersoc_engine.analysis.drive_info import _get_drive_type, drive_type
from cybersoc_engine.models import DriveInfoResponse
from cybersoc_engine.rpc.server import handle_line


@pytest.mark.parametrize("drive_type", ["FIXED", "REMOVABLE", "NETWORK", "CDROM", "UNKNOWN"])
def test_all_contract_drive_types(drive_type):
    value = {"jsonrpc": "2.0", "id": 1, "result": {"driveType": drive_type}}
    assert DriveInfoResponse.model_validate(value).model_dump() == value


@pytest.mark.parametrize("drive_type", ["USB", "RAMDISK", "", 1, None])
def test_invalid_contract_drive_types(drive_type):
    with pytest.raises(ValidationError):
        DriveInfoResponse.model_validate(
            {"jsonrpc": "2.0", "id": 1, "result": {"driveType": drive_type}}
        )


@pytest.mark.parametrize(
    "code,expected",
    [
        (0, "UNKNOWN"),
        (1, "UNKNOWN"),
        (2, "REMOVABLE"),
        (3, "FIXED"),
        (4, "NETWORK"),
        (5, "CDROM"),
        (6, "UNKNOWN"),
        (999, "UNKNOWN"),
    ],
)
def test_windows_codes_and_root_normalization(code, expected):
    with (
        patch("cybersoc_engine.analysis.drive_info.sys.platform", "win32"),
        patch("cybersoc_engine.analysis.drive_info._get_drive_type", return_value=code) as query,
    ):
        assert drive_type("e:/carpeta/niño.txt") == expected
    query.assert_called_once_with("E:\\")


def test_ctypes_declares_unicode_api():
    kernel = Mock()
    kernel.GetDriveTypeW.return_value = 3
    with patch("ctypes.WinDLL", return_value=kernel, create=True) as library:
        assert _get_drive_type("C:\\") == 3
    library.assert_called_once_with("kernel32", use_last_error=True)
    assert kernel.GetDriveTypeW.argtypes == [wintypes.LPCWSTR]
    assert kernel.GetDriveTypeW.restype == wintypes.UINT
    kernel.GetDriveTypeW.assert_called_once_with("C:\\")


@pytest.mark.parametrize(
    "path,expected",
    [
        (r"\\servidor\recurso\niño.txt", "NETWORK"),
        ("//server/share/file", "NETWORK"),
        (r"\\server", "UNKNOWN"),
        (r"\\?\C:\file", "UNKNOWN"),
        (r"\\.\PhysicalDrive0", "UNKNOWN"),
        ("relative.txt", "UNKNOWN"),
        ("C:file", "UNKNOWN"),
        ("C:", "UNKNOWN"),
        ("/tmp/file", "UNKNOWN"),
        ("C:\\nul\x00.txt", "UNKNOWN"),
    ],
)
def test_no_native_call_for_network_device_or_ambiguous_path(path, expected):
    with patch("cybersoc_engine.analysis.drive_info._get_drive_type") as query:
        assert drive_type(path) == expected
    query.assert_not_called()


def test_non_windows_and_native_failure():
    with (
        patch("cybersoc_engine.analysis.drive_info.sys.platform", "linux"),
        patch("cybersoc_engine.analysis.drive_info._get_drive_type") as query,
    ):
        assert drive_type("C:\\file.txt") == "UNKNOWN"
    query.assert_not_called()
    with (
        patch("cybersoc_engine.analysis.drive_info.sys.platform", "win32"),
        patch(
            "cybersoc_engine.analysis.drive_info._get_drive_type", side_effect=OSError("private")
        ),
    ):
        assert drive_type("C:\\file.txt") == "UNKNOWN"


@pytest.mark.parametrize(
    "params",
    [
        {},
        [],
        {"path": None},
        {"path": 1},
        {"path": ""},
        {"path": "C:\x00"},
        {"path": "C:\\", "extra": True},
    ],
)
def test_invalid_rpc_params(params):
    message = {"jsonrpc": "2.0", "id": 7, "method": "fs.driveInfo", "params": params}
    response = json.loads(handle_line(json.dumps(message).encode()).response)
    assert response["error"]["code"] == -32602


def test_real_process_drive_info_and_continues_after_bad_params():
    root = Path.cwd().anchor if sys.platform == "win32" else "C:\\"
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "fs.driveInfo", "params": {"path": root}},
        {"jsonrpc": "2.0", "id": 2, "method": "fs.driveInfo", "params": {"path": None}},
        {"jsonrpc": "2.0", "id": 3, "method": "engine.ping"},
    ]
    with engine_process() as process:
        stdout, _ = process.communicate(
            ("\n".join(json.dumps(m) for m in messages) + "\n").encode(), timeout=10
        )
        assert process.returncode == 0
    responses = [json.loads(line) for line in stdout.splitlines()]
    info = DriveInfoResponse.model_validate(responses[0])
    assert info.id == 1
    assert info.result.driveType == drive_type(root)
    if sys.platform == "win32":
        assert info.result.driveType in ("FIXED", "REMOVABLE", "NETWORK", "CDROM")
    assert responses[1]["error"]["code"] == -32602
    assert "ts" in responses[2]["result"]
