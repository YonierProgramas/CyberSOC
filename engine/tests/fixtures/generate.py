import hashlib
import random
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory


def generate_signature_fixtures(root: Path) -> dict[str, str]:
    """Writes five test TEXTS into the caller's temporary directory."""
    # Dict id -> hash: unique keys; O(1) average insert, O(n) for n fixtures.
    hashes: dict[str, str] = {}
    for index in range(1, 6):
        signature_id = f"CSD-TEST-{index:03}"
        content = f"CyberSOC Defender | {signature_id} | texto inofensivo de prueba.\n".encode()
        path = root / f"{signature_id}.txt"
        path.write_bytes(content)
        hashes[signature_id] = hashlib.sha256(content).hexdigest()
    return hashes


@contextmanager
def generate_fixtures(
    *,
    include_filetype: bool = False,
    include_signatures: bool = False,
    include_rules: bool = False,
    include_heuristics: bool = False,
) -> Iterator[Path]:
    """25 S1 texts; include_filetype adds the 3 harmless T2.2 samples."""
    with TemporaryDirectory(prefix="cybersoc-fixtures-") as temporary:
        root = Path(temporary)
        levels = (root, root / "nivel-2", root / "nivel-2" / "nivel-3")
        for level in levels:
            level.mkdir(parents=True, exist_ok=True)
        for index in range(25):
            path = levels[index % len(levels)] / f"año_información_📄_{index:02}.txt"
            path.write_bytes(f"Documento benigno de prueba {index:02}.\n".encode())
        if include_filetype:
            # Only MZ header and padding: it is neither a valid PE nor contains executable code.
            (root / "pe_disfrazado.pdf").write_bytes(b"MZ" + b"Relleno inofensivo.\n" * 3)
            (root / "factura.pdf.exe").write_bytes(b"Documento benigno de doble extension.\n")
            (root / "informe_\u202e.pdf").write_bytes(b"Documento benigno con RLO en el nombre.\n")
        if include_signatures:
            generate_signature_fixtures(root)
        if include_rules:
            generate_rule_fixtures(root)
        if include_heuristics:
            generate_heuristic_fixtures(root)
        yield root


def generate_heuristic_fixtures(root: Path) -> list[Path]:
    """Deterministic bytes and a marker comment; no commands or executable code."""
    contents = {
        "alta_entropia.bin": random.Random(340).randbytes(64 * 1024),
        "encoded_marker.ps1": b"# CYBERSOC_TEST_ENCODED_COMMAND\n# Texto inofensivo.\n",
        "pe_truncado.bin": b"MZ" + b"\0" * 30,
    }
    for name, content in contents.items():
        (root / name).write_bytes(content)
    return [root / name for name in contents]


def generate_rule_fixtures(root: Path) -> list[Path]:
    """Own markers without commands, executable content or real samples."""
    contents = {
        "rule_downloader.ps1": b"# CYBERSOC_TEST_RULE_DOWNLOADER\n# Texto inofensivo.\n",
        "rule_pair.txt": b"CYBERSOC_TEST_PAIR_START\nTexto inocuo.\nCYBERSOC_TEST_PAIR_END\n",
        "rule_utf16.txt": "CYBERSOC_TEST_UTF16\nTexto inofensivo.\n".encode("utf-16-le"),
        "rule_hex.txt": b"CYBERSOC_TEST_HEX\nTexto inofensivo.\n",
    }
    paths = []
    for name, content in contents.items():
        path = root / name
        path.write_bytes(content)
        paths.append(path)
    return paths
