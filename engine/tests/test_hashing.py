import hashlib
from io import BytesIO

import pytest

from cybersoc_engine.analysis.hashing import sha256_stream


@pytest.mark.parametrize(
    "content,expected",
    [
        (b"", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        (b"abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
    ],
)
def test_known_sha256(content, expected):
    stream = BytesIO(content)
    assert sha256_stream(stream) == expected
    assert not stream.closed


def test_fifty_mib_stream_matches_whole_file(tmp_path):
    path = tmp_path / "cincuenta-mebibytes.txt"
    block = b"Texto benigno.\n" * 70000
    size = 50 * 1024 * 1024
    with path.open("wb") as fh:
        remaining = size
        while remaining:
            part = block[:remaining]
            fh.write(part)
            remaining -= len(part)

    class BoundedReader:
        def __init__(self, fh):
            self.fh = fh
            self.reads = []

        def read(self, size=-1):
            assert size == 1024 * 1024
            self.reads.append(size)
            return self.fh.read(size)

    with path.open("rb") as fh:
        bounded = BoundedReader(fh)
        actual = sha256_stream(bounded)
    assert len(bounded.reads) == 51  # 50 chunks plus EOF
    assert path.stat().st_size == size
    assert actual == hashlib.sha256(path.read_bytes()).hexdigest()


def test_custom_chunk_and_current_stream_position():
    stream = BytesIO(b"prefix-abc")
    stream.seek(7)
    assert sha256_stream(stream, chunk=2) == hashlib.sha256(b"abc").hexdigest()


@pytest.mark.parametrize("chunk", [0, -1])
def test_nonpositive_chunk_rejected(chunk):
    with pytest.raises(ValueError):
        sha256_stream(BytesIO(b"abc"), chunk)
