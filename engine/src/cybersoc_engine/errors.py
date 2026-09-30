from cybersoc_engine.models import FileError


def map_file_error(error: OSError) -> FileError:
    # Sharing/lock violations can also be PermissionError: inspect winerror first.
    if getattr(error, "winerror", None) in (32, 33):
        return FileError(code="FILE_LOCKED", message="Archivo bloqueado por otro proceso")
    if isinstance(error, FileNotFoundError):
        return FileError(code="FILE_NOT_FOUND", message="Archivo no encontrado")
    if isinstance(error, PermissionError):
        return FileError(code="ACCESS_DENIED", message="Permiso denegado")
    return FileError(code="IO_ERROR", message="No se pudo leer el archivo")
