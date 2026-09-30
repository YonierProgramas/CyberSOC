import hashlib
from typing import BinaryIO


def sha256_stream(fh: BinaryIO, chunk: int = 1024 * 1024) -> str:
    """Hash from the current position without owning or closing the binary stream."""
    if chunk <= 0:
        raise ValueError("chunk must be positive")
    digest = hashlib.sha256()
    while block := fh.read(chunk):
        digest.update(block)
    return digest.hexdigest()
