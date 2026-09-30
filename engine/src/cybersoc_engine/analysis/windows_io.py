import ctypes
import os
from ctypes import wintypes


def readonly_opener(path: str, flags: int) -> int:
    """Preserve Windows sharing errors that the CRT otherwise reduces to EACCES."""
    import msvcrt

    if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
        raise ValueError("Only read-only opening is allowed")
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
    # GENERIC_READ, share read/write/delete, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL.
    handle = create(path, 0x80000000, 0x7, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        # Ownership passes to the descriptor, then to open(..., 'rb').
        return msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except BaseException:
        close(handle)
        raise
