import hashlib
import random
from io import BytesIO

import pytest

from cybersoc_engine.analysis.stream import (
    CHUNK_BYTES,
    HEADER_BYTES,
    ByteHistogram,
    HashConsumer,
    HeaderConsumer,
    consume_stream,
)


def test_single_pass_consumers_and_bounded_memory():
    block = bytes(range(256)) * (CHUNK_BYTES // 256)

    class VirtualFile:
        # 32 MiB virtuales: no construir una copia completa ni permitir seek/read(-1).
        remaining = 32
        reads = 0

        def read(self, size):
            assert size == CHUNK_BYTES
            self.reads += 1
            if not self.remaining:
                return b""
            self.remaining -= 1
            return block

    stream = VirtualFile()
    hashing, header, histogram = HashConsumer(), HeaderConsumer(), ByteHistogram()
    assert consume_stream(stream, (hashing, header, histogram)) == 32 * CHUNK_BYTES
    expected = hashlib.sha256()
    for _ in range(32):
        expected.update(block)
    assert hashing.hexdigest() == expected.hexdigest()
    assert header.data == block[:HEADER_BYTES]
    assert len(header.data) == HEADER_BYTES
    assert len(histogram.counts) == 256
    assert sum(histogram.counts) == histogram.total == 32 * CHUNK_BYTES
    assert histogram.entropy() == 8
    assert stream.reads == 33


def test_short_reads_are_not_eof_and_stream_remains_open():
    class ShortReads(BytesIO):
        def read(self, size):
            assert size == CHUNK_BYTES
            return super().read(3)

    stream = ShortReads(b"abcdefghi")
    hashing, header = HashConsumer(), HeaderConsumer()
    assert consume_stream(stream, (hashing, header)) == 9
    assert hashing.hexdigest() == hashlib.sha256(b"abcdefghi").hexdigest()
    assert header.data == b"abcdefghi"
    assert not stream.closed


def test_empty_file():
    histogram, header, hashing = ByteHistogram(), HeaderConsumer(), HashConsumer()
    assert consume_stream(BytesIO(), (histogram, header, hashing)) == 0
    assert histogram.entropy() == 0
    assert histogram.counts == [0] * 256
    assert header.data == b""
    assert hashing.hexdigest() == hashlib.sha256(b"").hexdigest()


@pytest.mark.parametrize("kind", ["ceros", "aleatorios", "texto"])
def test_entropy_files(tmp_path, kind, capsys):
    text = b"Este documento de prueba contiene palabras comunes y explica como funciona el antivirus.\n"
    content = {
        "ceros": b"\0" * CHUNK_BYTES,
        "aleatorios": random.Random(42).randbytes(CHUNK_BYTES),
        "texto": text * 12000,
    }[kind]
    path = tmp_path / f"{kind}.txt"
    path.write_bytes(content)
    histogram = ByteHistogram()
    with path.open("rb") as stream:
        consume_stream(stream, (histogram,))
    entropy = histogram.entropy()
    if kind == "ceros":
        assert entropy == 0
    elif kind == "aleatorios":
        assert 7.99 < entropy <= 8
    else:
        assert 4 <= entropy <= 5
    assert histogram.total == len(content)
    assert sum(histogram.counts) == len(content)
    # La evidencia sale solo desde pytest; stdout del motor continúa siendo JSON-RPC.
    with capsys.disabled():
        __import__("sys").stdout.write(
            f"ENTROPIA {kind}: {entropy:.6f} bits/byte; bytes={len(content)}\n"
        )
