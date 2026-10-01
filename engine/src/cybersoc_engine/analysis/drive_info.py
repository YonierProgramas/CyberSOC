"""Tipo de unidad sin abrir archivos, resolver enlaces ni consultar recursos de red."""

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
        # UNC se reconoce léxicamente: nunca se contacta al servidor para clasificarlo.
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
        # GetDriveTypeW exige la barra final. Solo consulta metadatos de la unidad;
        # no se usa la ruta del archivo ni se abre una unidad de red mapeada.
        code = _get_drive_type(drive.upper() + "\\")
    except OSError:
        return "UNKNOWN"
    # Dict inmutable por uso: cada código tiene un único tipo. Consulta O(1) promedio.
    types: dict[int, DriveType] = {2: "REMOVABLE", 3: "FIXED", 4: "NETWORK", 5: "CDROM"}
    # UNKNOWN, NO_ROOT_DIR, RAMDISK y códigos desconocidos no pertenecen a otro tipo.
    return types.get(code, "UNKNOWN")
