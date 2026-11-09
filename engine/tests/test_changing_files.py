"""AUD-02 regressions: the writer belongs to the test, never the engine."""

import hashlib
import os
from builtins import open as real_open

import pytest

from cybersoc_engine.analysis import file_inspector
from cybersoc_engine.analysis.stream import HashConsumer, consume_stream
from cybersoc_engine.models import EngineResult, ScanFileOptions


class InstrumentedReader:
    def __init__(self, stream, change):
        self.stream, self.change, self.changed = stream, change, False
        self.bytes_read = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.stream.close()

    def fileno(self):
        return self.stream.fileno()

    def read(self, size):
        chunk = self.stream.read(min(size, 3))
        self.bytes_read += len(chunk)
        if not self.changed:
            self.changed = True
            self.change()
        return chunk


@pytest.mark.parametrize("content,limit", [(b"", 0), (b"hola\n", 5), (b"hola\n", 8)])
def test_stable_empty_and_exact_limit_keep_size_hash_and_bytes(
    tmp_path, monkeypatch, content, limit
):
    path = tmp_path / "benigno.txt"
    path.write_bytes(content)
    before = path.stat()
    readers = []

    def instrument(target, *args, **kwargs):
        assert args[0] == "rb"
        reader = InstrumentedReader(real_open(target, *args, **kwargs), lambda: None)
        readers.append(reader)
        return reader

    monkeypatch.setattr(file_inspector, "open_binary", instrument)
    result = file_inspector.FileInspector().inspect(
        str(path), ScanFileOptions(maxBytes=limit), task_id="stable"
    )
    assert result.status == "SCANNED" and result.verdict == "CLEAN"
    assert result.file.sizeBytes == readers[0].bytes_read == len(content)
    assert result.hashes.sha256 == hashlib.sha256(content).hexdigest()
    assert path.read_bytes() == content and path.stat().st_mtime_ns == before.st_mtime_ns


@pytest.mark.parametrize("mutation", ["grow", "truncate", "rewrite", "replace", "short-read"])
def test_changed_read_is_error_without_hash_or_trusted_evidence(tmp_path, monkeypatch, mutation):
    path = tmp_path / "benigno.txt"
    path.write_bytes(b"hola\n")
    readers = []

    def change():
        if mutation == "grow":
            with real_open(path, "ab") as writer:
                writer.write(b"a" * 20)
        elif mutation == "truncate":
            with real_open(path, "r+b") as writer:
                writer.truncate(1)
        elif mutation == "rewrite":
            stamp = path.stat()
            path.write_bytes(b"adios")
            os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns + 1_000_000))
        elif mutation == "replace":
            os.rename(path, tmp_path / "original.txt")
            path.write_bytes(b"nuevo")

    def instrument(target, *args, **kwargs):
        reader = InstrumentedReader(real_open(target, *args, **kwargs), change)
        if mutation == "short-read":
            reader.read = lambda _size: b""  # Premature EOF without changing the metadata.
        readers.append(reader)
        return reader

    monkeypatch.setattr(file_inspector, "open_binary", instrument)
    result = file_inspector.FileInspector().inspect(
        str(path), ScanFileOptions(maxBytes=8), task_id="changed"
    )
    assert readers[0].bytes_read <= 8
    assert result.status == "ERROR" and result.verdict == "ERROR"
    assert result.error.code == "IO_ERROR"
    assert result.hashes is None and result.evidence == []
    assert result.score is None and result.riskLevel is None
    assert result.layers[0].status == "ERROR"
    EngineResult.model_validate(result.model_dump(mode="json", exclude_unset=True))


def test_changed_between_stat_and_open_is_rejected(tmp_path, monkeypatch):
    path = tmp_path / "benigno.txt"
    path.write_bytes(b"hola\n")

    def replace_before_open(target, *args, **kwargs):
        replacement = tmp_path / "nuevo.txt"
        replacement.write_bytes(b"nuevo")
        os.replace(replacement, target)
        return real_open(target, *args, **kwargs)

    monkeypatch.setattr(file_inspector, "open_binary", replace_before_open)
    result = file_inspector.FileInspector().inspect(
        str(path), ScanFileOptions(maxBytes=8), task_id="replace-open"
    )
    assert result.verdict == "ERROR" and result.hashes is None


def test_cancelled_read_never_becomes_clean(tmp_path, monkeypatch):
    path = tmp_path / "benigno.txt"
    path.write_bytes(b"hola\n")

    def cancelled():
        raise InterruptedError("Cancelación de lectura simulada")

    monkeypatch.setattr(
        file_inspector,
        "open_binary",
        lambda target, *args, **kwargs: InstrumentedReader(
            real_open(target, *args, **kwargs), cancelled
        ),
    )
    result = file_inspector.FileInspector().inspect(
        str(path), ScanFileOptions(maxBytes=8), task_id="cancel"
    )
    assert result.status == "ERROR" and result.verdict == "ERROR" and result.hashes is None


def test_stream_never_reads_a_sentinel_beyond_limit():
    class GrowingStream:
        total = 0

        def read(self, size):
            self.total += size
            return b"a" * size

    stream = GrowingStream()
    hashing = HashConsumer()
    assert consume_stream(stream, (hashing,), max_bytes=8) == stream.total == 8
    assert hashing.hexdigest() == hashlib.sha256(b"a" * 8).hexdigest()
