import ctypes
import hashlib
import os
import stat
from builtins import open as real_open
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from cybersoc_engine.analysis.file_inspector import (
    FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
    FILE_ATTRIBUTE_RECALL_ON_OPEN,
    FileInspector,
)
from cybersoc_engine.errors import map_file_error
from cybersoc_engine.models import EngineResult, ScanFileOptions


def inspect(path, max_bytes=1024 * 1024):
    result = FileInspector().inspect(str(path), ScanFileOptions(maxBytes=max_bytes), task_id="t_1")
    wire = result.model_dump(mode="json", exclude_unset=True)
    assert EngineResult.model_validate(wire).model_dump(exclude_unset=True) == wire
    assert result.evidence == []
    assert result.durationMs >= 0
    assert "verdict" not in wire
    return result


def test_unicode_metadata_hash_and_read_only(tmp_path):
    path = tmp_path / "año_información_📄.txt"
    content = "Texto de prueba, sin código ejecutable.\n".encode()
    path.write_bytes(content)
    before = path.stat()
    modes = []

    def record_open(path, mode="r", *args, **kwargs):
        modes.append(mode)
        return real_open(path, mode, *args, **kwargs)

    with patch("cybersoc_engine.analysis.file_inspector.open_binary", record_open):
        result = inspect(path)
    assert modes == ["rb"]
    assert result.status == "SCANNED"
    assert result.taskId == "t_1"
    assert result.file.name == path.name
    assert result.file.extension == ".txt"
    assert result.file.sizeBytes == len(content)
    assert (
        abs(datetime.fromisoformat(result.file.modifiedAt).timestamp() - before.st_mtime) < 0.00001
    )
    assert result.hashes.sha256 == hashlib.sha256(content).hexdigest()
    assert result.error is None
    assert path.read_bytes() == content
    assert path.stat().st_mtime_ns == before.st_mtime_ns


def test_no_extension_and_empty_file(tmp_path):
    path = tmp_path / "sin_extension"
    path.write_bytes(b"")
    result = inspect(path, max_bytes=0)
    assert result.status == "SCANNED"
    assert result.file.extension is None
    assert result.hashes.sha256 == hashlib.sha256(b"").hexdigest()


@pytest.mark.parametrize("limit,status", [(2, "SKIPPED"), (3, "SCANNED"), (4, "SCANNED")])
def test_size_limit_boundary(tmp_path, limit, status):
    path = tmp_path / "limite.txt"
    path.write_bytes(b"abc")
    result = inspect(path, max_bytes=limit)
    assert result.status == status
    if status == "SKIPPED":
        assert result.error.code == "TOO_LARGE"
        assert result.hashes is None


def test_oversize_never_opens_file(tmp_path):
    path = tmp_path / "grande.txt"
    path.write_bytes(b"abcd")
    with patch(
        "cybersoc_engine.analysis.file_inspector.open_binary",
        side_effect=AssertionError("must not open"),
    ):
        result = inspect(path, max_bytes=3)
    assert result.error.code == "TOO_LARGE"


@pytest.mark.parametrize(
    "attribute",
    [
        stat.FILE_ATTRIBUTE_OFFLINE,
        FILE_ATTRIBUTE_RECALL_ON_OPEN,
        FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
        stat.FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
    ],
)
def test_cloud_attributes_skip_without_opening(tmp_path, attribute):
    metadata = SimpleNamespace(st_file_attributes=attribute, st_size=5, st_mode=stat.S_IFREG)
    with (
        patch.object(Path, "stat", return_value=metadata),
        patch(
            "cybersoc_engine.analysis.file_inspector.open_binary",
            side_effect=AssertionError("must not hydrate"),
        ),
    ):
        result = inspect(tmp_path / "nube.txt", max_bytes=1)
    assert result.status == "SKIPPED"
    assert result.error.code == "CLOUD_PLACEHOLDER"
    assert result.hashes is None


def test_hydrated_reparse_file_without_recall_is_scanned(tmp_path):
    path = tmp_path / "local.txt"
    path.write_bytes(b"abc")
    actual = path.stat()
    metadata = SimpleNamespace(
        st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT,
        st_size=actual.st_size,
        st_mode=actual.st_mode,
        st_mtime=actual.st_mtime,
    )
    with patch.object(Path, "stat", return_value=metadata):
        assert inspect(path).status == "SCANNED"


def test_no_windows_attributes_available(tmp_path):
    path = tmp_path / "local.txt"
    path.write_bytes(b"abc")
    actual = path.stat()
    metadata = SimpleNamespace(st_size=3, st_mode=actual.st_mode, st_mtime=actual.st_mtime)
    with patch.object(Path, "stat", return_value=metadata):
        assert inspect(path).status == "SCANNED"


def test_size_rechecked_on_open_handle(tmp_path):
    path = tmp_path / "crecido.txt"
    path.write_bytes(b"abcd")
    actual = path.stat()
    metadata = SimpleNamespace(st_size=1, st_mode=actual.st_mode, st_mtime=actual.st_mtime)
    with (
        patch.object(Path, "stat", return_value=metadata),
        patch("cybersoc_engine.analysis.file_inspector.sha256_stream") as hashing,
    ):
        result = inspect(path, max_bytes=2)
    assert result.error.code == "TOO_LARGE"
    hashing.assert_not_called()


def test_missing_file(tmp_path):
    result = inspect(tmp_path / "no-existe.txt")
    assert result.status == "ERROR"
    assert result.error.code == "FILE_NOT_FOUND"


@pytest.mark.parametrize("operation", ["stat", "open"])
def test_permission_denied_is_file_error(tmp_path, operation):
    path = tmp_path / "denegado.txt"
    path.write_bytes(b"abc")
    target = (
        "pathlib.Path.stat"
        if operation == "stat"
        else "cybersoc_engine.analysis.file_inspector.open_binary"
    )
    with patch(target, side_effect=PermissionError("denied")):
        result = inspect(path)
    assert result.status == "ERROR"
    assert result.error.code == "ACCESS_DENIED"
    assert result.hashes is None


def test_read_failure_closes_file(tmp_path):
    path = tmp_path / "lectura.txt"
    path.write_bytes(b"abc")
    fh = path.open("rb")
    with (
        patch("cybersoc_engine.analysis.file_inspector.open_binary", return_value=fh),
        patch("cybersoc_engine.analysis.file_inspector.sha256_stream", side_effect=OSError("read")),
    ):
        result = inspect(path)
    assert result.status == "ERROR"
    assert result.error.code == "IO_ERROR"
    assert result.hashes is None
    assert fh.closed


@pytest.mark.parametrize(
    "error,code",
    [
        (FileNotFoundError(), "FILE_NOT_FOUND"),
        (PermissionError(), "ACCESS_DENIED"),
        (OSError(), "IO_ERROR"),
    ],
)
def test_os_error_mapping(error, code):
    assert map_file_error(error).code == code


@pytest.mark.parametrize("winerror", [32, 33])
def test_lock_code_precedes_permission_error(winerror):
    error = PermissionError("locked")
    error.winerror = winerror
    assert map_file_error(error).code == "FILE_LOCKED"


def test_directory_is_not_opened(tmp_path):
    with patch(
        "cybersoc_engine.analysis.file_inspector.open_binary",
        side_effect=AssertionError("must not open"),
    ):
        result = inspect(tmp_path)
    assert result.error.code == "IO_ERROR"


def test_symbolic_link_is_not_followed(tmp_path):
    metadata = SimpleNamespace(st_size=3, st_mode=stat.S_IFLNK)
    with (
        patch.object(Path, "stat", return_value=metadata) as get_stat,
        patch(
            "cybersoc_engine.analysis.file_inspector.open_binary",
            side_effect=AssertionError("must not follow"),
        ),
    ):
        result = inspect(tmp_path / "link")
    get_stat.assert_called_once_with(follow_symlinks=False)
    assert result.error.code == "IO_ERROR"


@pytest.mark.parametrize("path", [r"\\server\share\file.txt", "//server/share/file.txt"])
def test_unc_rejected_before_filesystem_access(path):
    with patch.object(Path, "stat", side_effect=AssertionError("must not access network")):
        result = inspect(path)
    assert result.error.code == "IO_ERROR"


def test_nul_in_path_is_file_error():
    assert inspect("invalid\0path").error.code == "IO_ERROR"


@pytest.mark.skipif(os.name != "nt", reason="Windows sharing violation")
def test_actual_windows_file_lock(tmp_path):
    from ctypes import wintypes

    path = tmp_path / "bloqueado.txt"
    path.write_bytes(b"abc")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    handle = create(str(path), 0x80000000, 0, None, 3, 0x80, None)
    assert handle != ctypes.c_void_p(-1).value, ctypes.get_last_error()
    try:
        result = inspect(path)
        assert result.status == "ERROR"
        assert result.error.code == "FILE_LOCKED"
    finally:
        assert close(handle)
