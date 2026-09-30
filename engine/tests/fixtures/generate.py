from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory


@contextmanager
def generate_fixtures(*, include_filetype: bool = False) -> Iterator[Path]:
    """25 textos S1; include_filetype agrega las 3 muestras inofensivas de T2.2."""
    with TemporaryDirectory(prefix="cybersoc-fixtures-") as temporary:
        root = Path(temporary)
        levels = (root, root / "nivel-2", root / "nivel-2" / "nivel-3")
        for level in levels:
            level.mkdir(parents=True, exist_ok=True)
        for index in range(25):
            path = levels[index % len(levels)] / f"año_información_📄_{index:02}.txt"
            path.write_bytes(f"Documento benigno de prueba {index:02}.\n".encode())
        if include_filetype:
            # Solo cabecera MZ y relleno: no es un PE válido ni contiene código ejecutable.
            (root / "pe_disfrazado.pdf").write_bytes(b"MZ" + b"Relleno inofensivo.\n" * 3)
            (root / "factura.pdf.exe").write_bytes(b"Documento benigno de doble extension.\n")
            (root / "informe_\u202e.pdf").write_bytes(b"Documento benigno con RLO en el nombre.\n")
        yield root
