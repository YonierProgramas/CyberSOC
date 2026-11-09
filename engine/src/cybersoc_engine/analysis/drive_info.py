"""Drive type without opening files, resolving links or querying network resources."""

import ctypes
import ntpath
import sys
from ctypes import wintypes

from cybersoc_engine.models import DriveType


def _get_drive_type(root: str) -> int:
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    get_type = kernel.GetDriveTypeW
    get_type.argtypes = [wintypes.LPCWSTR]
    get_type.restype = wintypes.UINT
    return get_type(root)


def drive_type(path: str) -> DriveType:
    normalized = path.replace("/", "\\")
    if "\x00" in normalized or normalized.startswith(("\\\\?\\", "\\\\.\\")):
        return "UNKNOWN"
    drive, tail = ntpath.splitdrive(normalized)
    if drive.startswith("\\\\"):
        # UNC is recognized lexically: the server is never contacted to classify it.
        parts = drive[2:].split("\\")
        return "NETWORK" if len(parts) == 2 and all(parts) else "UNKNOWN"
    if (
        len(drive) != 2
        or drive[0] not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        or drive[1] != ":"
        or not tail.startswith("\\")
        or sys.platform != "win32"
    ):
        return "UNKNOWN"
    try:
        # GetDriveTypeW requires the trailing slash. It only queries drive metadata;
        # the file path is not used and no mapped network drive is opened.
        code = _get_drive_type(drive.upper() + "\\")
    except OSError:
        return "UNKNOWN"
    # Dict immutable by use: each code has a single type. O(1) average lookup.
    types: dict[int, DriveType] = {2: "REMOVABLE", 3: "FIXED", 4: "NETWORK", 5: "CDROM"}
    # UNKNOWN, NO_ROOT_DIR, RAMDISK and unknown codes belong to no other type.
    return types.get(code, "UNKNOWN")
