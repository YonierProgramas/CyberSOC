from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory


@contextmanager
def generate_fixtures() -> Iterator[Path]:
    """Own a fresh temporary tree of 25 text files across three directory levels."""
    with TemporaryDirectory(prefix="cybersoc-fixtures-") as temporary:
        root = Path(temporary)
        levels = (root, root / "nivel-2", root / "nivel-2" / "nivel-3")
        for level in levels:
            level.mkdir(parents=True, exist_ok=True)
        for index in range(25):
            path = levels[index % len(levels)] / f"año_información_📄_{index:02}.txt"
            path.write_bytes(f"Documento benigno de prueba {index:02}.\n".encode())
        yield root
