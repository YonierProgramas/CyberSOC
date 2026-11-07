"""Fixture local: error real del motor para el contrato y la persistencia TS."""
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "engine" / "src"))
from cybersoc_engine.analysis import file_inspector  # noqa: E402
from cybersoc_engine.models import ScanFileOptions  # noqa: E402

original_open = file_inspector.open_binary


class Reader:
    def __init__(self, stream, path):
        self.stream, self.path, self.changed = stream, path, False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.stream.close()

    def fileno(self):
        return self.stream.fileno()

    def read(self, size):
        chunk = self.stream.read(size)
        if not self.changed:
            self.changed = True
            with original_open(self.path, "ab") as writer:
                writer.write(b"a" * 20)
        return chunk


with tempfile.TemporaryDirectory(prefix="cybersoc-changing-host-") as folder:
    path = Path(folder) / "benigno.txt"
    path.write_bytes(b"hola\n")
    with patch.object(file_inspector, "open_binary", lambda p, *a, **k: Reader(original_open(p, *a, **k), path)):
        result = file_inspector.FileInspector().inspect(str(path), ScanFileOptions(maxBytes=8), task_id="changed")
    sys.stdout.write(json.dumps(result.model_dump(mode="json", exclude_unset=True)))
