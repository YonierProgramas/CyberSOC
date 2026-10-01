"""Un recorrido secuencial; los consumidores nunca abren ni rebobinan el archivo."""

import hashlib
import math
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


def consume_stream(stream: BinaryIO, consumers: tuple[Consumer, ...]) -> int:
    """Lee bloques de 1 MiB hasta EOF una vez; no cierra el descriptor del llamador."""
    total = 0
    while chunk := stream.read(CHUNK_BYTES):
        for consumer in consumers:
            consumer.consume(chunk)
        total += len(chunk)
    return total
