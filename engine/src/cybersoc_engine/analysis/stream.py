"""One sequential traversal; consumers never open or rewind the file."""

import hashlib
import math
from collections.abc import Callable
from typing import BinaryIO, Protocol

CHUNK_BYTES = 1024 * 1024
HEADER_BYTES = 64 * 1024


class Consumer(Protocol):
    def consume(self, chunk: bytes) -> None: ...


class HashConsumer:
    def __init__(self) -> None:
        self._hash = hashlib.sha256()

    def consume(self, chunk: bytes) -> None:
        """O(len(chunk)); SHA-256 keeps a constant-size state."""
        self._hash.update(chunk)

    def hexdigest(self) -> str:
        return self._hash.hexdigest()


class HeaderConsumer:
    def __init__(self) -> None:
        self._header = bytearray()

    def consume(self, chunk: bytes) -> None:
        # Invariant: only the first 64 KiB; it does not grow with the file size.
        # Copying costs O(min(len(chunk), remaining space)); afterwards it costs O(1).
        remaining = HEADER_BYTES - len(self._header)
        if remaining:
            self._header.extend(chunk[:remaining])

    @property
    def data(self) -> bytes:
        return bytes(self._header)


class ByteHistogram:
    def __init__(self) -> None:
        # Array of 256 counters: a byte only has values 0..255. The index
        # is the byte; no lookups or dictionary keys are needed.
        # Invariant: counts[b] counts b and sum(counts) == total after each block.
        self.counts = [0] * 256
        self.total = 0

    def consume(self, chunk: bytes) -> None:
        # O(1) per byte, O(n) per block; O(256) memory, independent of the file.
        for byte in chunk:
            self.counts[byte] += 1
        self.total += len(chunk)

    def entropy(self) -> float:
        # Shannon H = -sum(p * log2(p)), p = frecuencia/total; omitir p=0.
        # Range 0..8 bits/byte: a single value -> 0, 256 equiprobable -> 8.
        # O(256) time and O(1) extra space. For empty input we define 0.
        if not self.total:
            return 0.0
        return -sum(
            (count / self.total) * math.log2(count / self.total) for count in self.counts if count
        )


class BoundedSample:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.data = bytearray()

    def consume(self, chunk: bytes) -> None:
        # Invariant: len(data) <= fixed limit. O(retained bytes) time and
        # O(limit) memory; it never grows with a large file nor rereads the disk.
        self.data.extend(chunk[: max(0, self.limit - len(self.data))])


class FileChangedError(OSError):
    """The read no longer matches the stable file admitted at the start."""


def consume_stream(
    stream: BinaryIO,
    consumers: tuple[Consumer, ...],
    *,
    max_bytes: int | None = None,
    check_unchanged: Callable[[], None] | None = None,
) -> int:
    """One bounded traversal; it never requests or delivers more than max_bytes to the layers."""
    total = 0
    # Invariant: 0 <= total <= max_bytes, if there is a limit. Each block costs O(b)
    # plus the consumers; O(CHUNK_BYTES) memory. We do not read a sentinel byte
    # beyond the limit: the inspector checks EOF/size through the descriptor.
    while True:
        if check_unchanged is not None:
            check_unchanged()
        remaining = CHUNK_BYTES if max_bytes is None else min(CHUNK_BYTES, max_bytes - total)
        if remaining <= 0:
            break
        chunk = stream.read(remaining)
        if check_unchanged is not None:
            check_unchanged()
        if not chunk:
            break
        if len(chunk) > remaining:
            raise FileChangedError("Read above the requested limit")
        for consumer in consumers:
            consumer.consume(chunk)
        total += len(chunk)
    return total
