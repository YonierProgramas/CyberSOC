import pytest

from cybersoc_engine.engines.base import AnalysisContext
from cybersoc_engine.engines.filetype_engine import (
    MAGIC_NUMBERS,
    FileType,
    FileTypeEngine,
    detect_type,
)
from cybersoc_engine.models import FileInfo


def context(name, prefix=b"Texto inofensivo."):
    from pathlib import PurePath

    return AnalysisContext(
        file=FileInfo(
            name=name,
            extension=PurePath(name).suffix or None,
            sizeBytes=len(prefix),
            modifiedAt="2026-09-30T00:00:00Z",
        ),
        prefix=prefix,
        sha256="a" * 64,
    )


@pytest.mark.parametrize(
    "prefix,name,expected",
    [
        (b"MZ", "archivo.exe", "PE ejecutable"),
        (b"%PDF", "archivo.pdf", "PDF"),
        (b"PK\x03\x04", "archivo.zip", "ZIP / OOXML"),
        (b"\xd0\xcf\x11\xe0", "archivo.doc", "Office 97 (OLE)"),
        (b"\x7fELF", "archivo.elf", "ELF"),
        (b"\x89PNG", "archivo.png", "PNG"),
        (b"\xff\xd8\xff", "archivo.jpg", "JPEG"),
        (b"Rar!", "archivo.rar", "RAR"),
        (b"\x1f\x8b", "archivo.gz", "GZIP"),
        (b"L\x00\x00\x00", "archivo.lnk", "Acceso directo LNK"),
    ],
)
def test_each_magic_number_and_matching_extension(prefix, name, expected):
    ctx = context(name, prefix + b"relleno")
    assert detect_type(ctx.prefix, ctx.file.extension).name == expected
    assert FileTypeEngine().analyze(ctx) == []


def test_longest_matching_prefix_wins(monkeypatch):
    specific = FileType("Tipo más específico de prueba", (".test",))
    monkeypatch.setitem(MAGIC_NUMBERS, b"MZAB", specific)
    assert detect_type(b"MZABrelleno", ".test") == specific
    assert detect_type(b"MZCDrelleno", ".exe").name == "PE ejecutable"


@pytest.mark.parametrize("prefix", [b"", b"M", b"%PD", b"PK\x03", b"\xff\xd8", b"unknown"])
def test_unknown_or_incomplete_magic_does_not_invent_a_mismatch(prefix):
    assert detect_type(prefix, ".pdf") is None
    assert FileTypeEngine().analyze(context("archivo.pdf", prefix)) == []


@pytest.mark.parametrize(
    "name,prefix,severity,points",
    [
        ("factura.pdf", b"MZrelleno", "HIGH", 25),
        ("foto.png", b"\x7fELFrelleno", "HIGH", 25),
        ("foto.jpg", b"%PDFrelleno", "MEDIUM", 15),
        ("archivo.exe", b"\x89PNGrelleno", "MEDIUM", 15),
    ],
)
def test_type_mismatch(name, prefix, severity, points):
    findings = FileTypeEngine().analyze(context(name, prefix))
    assert len(findings) == 1
    evidence = findings[0]
    assert (evidence.code, evidence.severity, evidence.points) == (
        "TYPE_MISMATCH",
        severity,
        points,
    )
    assert evidence.source == "FILETYPE"
    assert evidence.decisive is False
    assert evidence.facts["extension"] == context(name).file.extension
    assert evidence.facts["detectedType"]


@pytest.mark.parametrize(
    "name,prefix",
    [
        ("foto.JPEG", b"\xff\xd8\xff"),
        ("informe.docx", b"PK\x03\x04"),
        ("planilla.xlsx", b"PK\x03\x04"),
        ("presentacion.pptx", b"PK\x03\x04"),
        ("biblioteca.DLL", b"MZ"),
        ("programa", b"\x7fELF"),
        ("texto.exe", b"Texto sin tipo conocido."),
    ],
)
def test_aliases_case_missing_extension_and_unknown_type(name, prefix):
    assert FileTypeEngine().analyze(context(name, prefix)) == []


@pytest.mark.parametrize(
    "name", ["factura.pdf.exe", "FACTURA.PDF.EXE", "nota.txt.cmd", "foto.jpg.scr"]
)
def test_double_extension_is_detected_even_with_plain_text(name):
    findings = FileTypeEngine().analyze(context(name))
    assert len(findings) == 1
    evidence = findings[0]
    assert (evidence.code, evidence.severity, evidence.points) == ("DOUBLE_EXTENSION", "HIGH", 25)
    assert evidence.confidence == 0.8
    assert evidence.decisive is False
    assert evidence.facts["visibleExtension"] == "." + name.lower().split(".")[-2]
    assert evidence.facts["realExtension"] == "." + name.lower().split(".")[-1]


@pytest.mark.parametrize(
    "name",
    ["archivo.exe", "informe.v2.pdf", "archivo.tar.gz", "notas.txt", ".exe", "factura.exe.pdf"],
)
def test_benign_multiple_dots_are_not_double_extension(name):
    assert FileTypeEngine().analyze(context(name)) == []


@pytest.mark.parametrize("name,count", [("informe_\u202efdp.exe", 1), ("a\u202eb\u202e.pdf", 2)])
def test_rlo_in_name(name, count):
    findings = FileTypeEngine().analyze(context(name))
    assert len(findings) == 1
    evidence = findings[0]
    assert (evidence.code, evidence.severity, evidence.points) == ("RLO_IN_NAME", "HIGH", 25)
    assert evidence.facts == {"character": "U+202E", "count": count}
    assert evidence.decisive is False


@pytest.mark.parametrize("name", ["informe.pdf", "año_📄.pdf", "informe_\u202afdp.exe"])
def test_rlo_absent(name):
    assert FileTypeEngine().analyze(context(name)) == []


def test_stable_order_with_all_three_findings():
    ctx = context("informe_\u202e.pdf.exe", b"%PDFrelleno")
    first = FileTypeEngine().analyze(ctx)
    assert [item.code for item in first] == ["TYPE_MISMATCH", "DOUBLE_EXTENSION", "RLO_IN_NAME"]
    assert [item.id for item in first] == ["ev1", "ev2", "ev3"]
    assert FileTypeEngine().analyze(ctx) == first


@pytest.mark.parametrize("extension", [".ps1", ".bat", ".cmd", ".vbs", ".js", ".py", ".sh", ".PS1"])
@pytest.mark.parametrize(
    "prefix", [b"Texto inofensivo\r\n", "Texto español".encode(), "Texto inocuo".encode("utf-16")]
)
def test_scripts_need_extension_and_text(extension, prefix):
    assert detect_type(prefix, extension).name == "Script de texto"
    assert FileTypeEngine().analyze(context("muestra" + extension, prefix)) == []


@pytest.mark.parametrize("prefix", [b"", b"\x00abc", b"\xff\x80\x01", b"abc\x07"])
def test_binary_or_empty_content_is_not_called_a_script(prefix):
    assert detect_type(prefix, ".ps1") is None


def test_magic_takes_precedence_over_script_extension():
    assert detect_type(b"MZrelleno", ".ps1").name == "PE ejecutable"
    assert FileTypeEngine().analyze(context("muestra.ps1", b"MZrelleno"))[0].code == "TYPE_MISMATCH"
    assert detect_type(b"Texto inofensivo", ".txt") is None


def test_text_sample_can_end_in_partial_utf8_character():
    assert detect_type(b"Texto " + "ñ".encode()[:1], ".ps1").name == "Script de texto"
