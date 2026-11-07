"""Un recorrido secuencial; los consumidores nunca abren ni rebobinan el archivo."""

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
        """O(len(chunk)); SHA-256 conserva un estado de tamaño constante."""
        self._hash.update(chunk)

    def hexdigest(self) -> str:
        return self._hash.hexdigest()


class HeaderConsumer:
    def __init__(self) -> None:
        self._header = bytearray()

    def consume(self, chunk: bytes) -> None:
        # Invariante: solo los primeros 64 KiB; no crece con el tamaño del archivo.
        # Copiar cuesta O(min(len(chunk), espacio restante)); después cuesta O(1).
        remaining = HEADER_BYTES - len(self._header)
        if remaining:
            self._header.extend(chunk[:remaining])

    @property
    def data(self) -> bytes:
        return bytes(self._header)


class ByteHistogram:
    def __init__(self) -> None:
        # Arreglo de 256 contadores: un byte solo tiene valores 0..255. El índice
        # es el byte; no hacen falta búsquedas ni claves de un diccionario.
        # Invariante: counts[b] cuenta b y sum(counts) == total tras cada bloque.
        self.counts = [0] * 256
        self.total = 0

    def consume(self, chunk: bytes) -> None:
        # O(1) por byte, O(n) por bloque; memoria O(256), independiente del archivo.
        for byte in chunk:
            self.counts[byte] += 1
        self.total += len(chunk)

    def entropy(self) -> float:
        # Shannon H = -sum(p * log2(p)), p = frecuencia/total; omitir p=0.
        # Rango 0..8 bits/byte: un solo valor -> 0, 256 equiprobables -> 8.
        # O(256) tiempo y O(1) espacio adicional. Para entrada vacía definimos 0.
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
        # Invariante: len(data) <= límite fijo. O(bytes retenidos) tiempo y
        # O(límite) memoria; nunca crece con un archivo grande ni relee el disco.
        self.data.extend(chunk[: max(0, self.limit - len(self.data))])


class FileChangedError(OSError):
    """La lectura ya no corresponde al archivo estable admitido al comenzar."""


def consume_stream(
    stream: BinaryIO,
    consumers: tuple[Consumer, ...],
    *,
    max_bytes: int | None = None,
    check_unchanged: Callable[[], None] | None = None,
) -> int:
    """Un recorrido acotado; nunca solicita ni entrega más de max_bytes a las capas."""
    total = 0
    # Invariante: 0 <= total <= max_bytes, si hay límite. Cada bloque cuesta O(b)
    # más los consumidores; memoria O(CHUNK_BYTES). No leemos un byte centinela
    # fuera del límite: el inspector comprueba EOF/tamaño por el descriptor.
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
            raise FileChangedError("Lectura superior al límite solicitado")
        for consumer in consumers:
            consumer.consume(chunk)
        total += len(chunk)
    return total
