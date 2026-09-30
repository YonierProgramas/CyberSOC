import codecs
from dataclasses import dataclass
from pathlib import PurePath
from typing import Literal

from cybersoc_engine.engines.base import AnalysisContext
from cybersoc_engine.models import Evidence


@dataclass(frozen=True)
class FileType:
    name: str
    extensions: tuple[str, ...]
    executable: bool = False


# Invariante: cada prefijo tiene un único tipo. El dict evita recorrer todos los
# tipos: get cuesta O(1) promedio, además de O(l) para copiar/hashear l bytes.
MAGIC_NUMBERS: dict[bytes, FileType] = {
    b"MZ": FileType(
        "PE ejecutable", (".exe", ".dll", ".sys", ".scr", ".com", ".cpl", ".ocx"), True
    ),
    b"%PDF": FileType("PDF", (".pdf",)),
    b"PK\x03\x04": FileType(
        "ZIP / OOXML",
        (
            ".zip",
            ".docx",
            ".xlsx",
            ".pptx",
            ".docm",
            ".xlsm",
            ".pptm",
            ".odt",
            ".ods",
            ".odp",
            ".jar",
        ),
    ),
    b"\xd0\xcf\x11\xe0": FileType("Office 97 (OLE)", (".doc", ".xls", ".ppt", ".msg", ".msi")),
    b"\x7fELF": FileType("ELF", (".elf", ".so", ".bin"), True),
    b"\x89PNG": FileType("PNG", (".png",)),
    b"\xff\xd8\xff": FileType("JPEG", (".jpg", ".jpeg", ".jpe")),
    b"Rar!": FileType("RAR", (".rar",)),
    b"\x1f\x8b": FileType("GZIP", (".gz", ".gzip", ".tgz")),
    b"L\x00\x00\x00": FileType("Acceso directo LNK", (".lnk",)),
}
# El set elimina longitudes repetidas; construirlo cuesta O(m), ordenar O(k log k).
# Se calcula una vez: el invariante es probar siempre el prefijo más largo primero.
PREFIX_LENGTHS = tuple(sorted({len(magic) for magic in MAGIC_NUMBERS}, reverse=True))
SCRIPT_EXTENSIONS = (".ps1", ".psm1", ".bat", ".cmd", ".vbs", ".vbe", ".js", ".jse", ".py", ".sh")
EXECUTABLE_EXTENSIONS = (".exe", ".scr", ".com", ".cpl", ".msi", ".lnk", *SCRIPT_EXTENSIONS)
DOCUMENT_EXTENSIONS = (
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".txt",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".zip",
    ".rar",
)


def is_text(prefix: bytes) -> bool:
    """Verificación conservadora de una muestra UTF-8 o UTF-16 con BOM."""
    if not prefix:
        return False
    encoding = "utf-16" if prefix.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
    try:
        # final=False permite que la muestra termine a mitad de un carácter.
        text = codecs.getincrementaldecoder(encoding)(errors="strict").decode(prefix, final=False)
    except UnicodeDecodeError:
        return False
    return bool(text) and all(char.isprintable() or char in "\r\n\t" for char in text)


def detect_type(prefix: bytes, extension: str | None) -> FileType | None:
    # k consultas de dict en orden descendente; O(sum(longitudes)) tiempo y
    # O(longitud máxima) espacio auxiliar. Con 4, 3 y 2 bytes es O(1).
    for length in PREFIX_LENGTHS:
        if len(prefix) >= length:
            found = MAGIC_NUMBERS.get(prefix[:length])
            if found is not None:
                return found
    if extension and extension.lower() in SCRIPT_EXTENSIONS and is_text(prefix):
        return FileType("Script de texto", (extension.lower(),), True)
    return None


class FileTypeEngine:
    layer_id: Literal["FILETYPE"] = "FILETYPE"

    def analyze(self, ctx: AnalysisContext) -> list[Evidence]:
        evidence: list[Evidence] = []
        extension = ctx.file.extension.lower() if ctx.file.extension else None
        detected = detect_type(ctx.prefix, extension)
        if detected is not None and extension and extension not in detected.extensions:
            evidence.append(
                Evidence(
                    id="ev1",
                    source=self.layer_id,
                    code="TYPE_MISMATCH",
                    title="El tipo del archivo no coincide con su extensión",
                    severity="HIGH" if detected.executable else "MEDIUM",
                    points=25 if detected.executable else 15,
                    decisive=False,
                    confidence=0.9,
                    facts={
                        "detectedType": detected.name,
                        "extension": extension,
                        "expectedExtensions": list(detected.extensions),
                    },
                )
            )
        # Solo se usa el nombre: un punto o un RLO en la carpeta no es un hallazgo.
        suffixes = PurePath(ctx.file.name).suffixes
        if (
            len(suffixes) >= 2
            and suffixes[-2].lower() in DOCUMENT_EXTENSIONS
            and suffixes[-1].lower() in EXECUTABLE_EXTENSIONS
        ):
            evidence.append(
                Evidence(
                    id=f"ev{len(evidence) + 1}",
                    source=self.layer_id,
                    code="DOUBLE_EXTENSION",
                    title="Doble extensión",
                    severity="HIGH",
                    points=25,
                    decisive=False,
                    confidence=0.8,
                    facts={
                        "visibleExtension": suffixes[-2].lower(),
                        "realExtension": suffixes[-1].lower(),
                    },
                )
            )
        if "\u202e" in ctx.file.name:
            evidence.append(
                Evidence(
                    id=f"ev{len(evidence) + 1}",
                    source=self.layer_id,
                    code="RLO_IN_NAME",
                    title="Carácter que invierte la presentación del nombre",
                    severity="HIGH",
                    points=25,
                    decisive=False,
                    confidence=1,
                    facts={"character": "U+202E", "count": ctx.file.name.count("\u202e")},
                )
            )
        # Orden estable: discrepancia, doble extensión, RLO. Nunca hay veredicto.
        return evidence
