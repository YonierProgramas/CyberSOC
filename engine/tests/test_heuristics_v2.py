import hashlib
import os
import shutil
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from time import perf_counter
from unittest.mock import patch

import pytest
from fixtures.generate import generate_heuristic_fixtures

from cybersoc_engine.analysis.file_inspector import FileInspector
from cybersoc_engine.analysis.stream import BoundedSample
from cybersoc_engine.engines.base import AnalysisContext
from cybersoc_engine.engines.heuristics_engine import HeuristicsEngine
from cybersoc_engine.engines.pe_engine import PE_MAX_BYTES, PEEngine, inspect_pe
from cybersoc_engine.engines.rule_engine import RuleStore
from cybersoc_engine.engines.script_engine import SCRIPT_MAX_BYTES, ScriptEngine
from cybersoc_engine.models import FileInfo, ScanFileOptions


def context(**changes):
    base = AnalysisContext(
        FileInfo(name="safe.txt", extension=".txt", sizeBytes=0, modifiedAt="now"),
        b"text",
        "a" * 64,
    )
    return replace(base, **changes)


def codes(engine, ctx):
    return [item.code for item in engine.analyze(ctx)]


@pytest.mark.parametrize(
    "entropy,expected", [(0, False), (4.5, False), (7.2, False), (7.2001, True), (8, True)]
)
def test_entropy_threshold(entropy, expected):
    assert ("HIGH_ENTROPY" in codes(HeuristicsEngine(), context(entropy=entropy))) == expected


@pytest.mark.parametrize(
    "zone,expected",
    [("DESCARGAS", True), ("TEMPORALES", True), ("SISTEMA", False), ("OTRA", False), (None, False)],
)
def test_executable_zone(zone, expected):
    assert (
        "EXEC_IN_DOWNLOADS_OR_TEMP" in codes(HeuristicsEngine(), context(prefix=b"MZ", zone=zone))
    ) == expected
    assert "EXEC_IN_DOWNLOADS_OR_TEMP" not in codes(HeuristicsEngine(), context(zone=zone))


@pytest.mark.parametrize(
    "attributes,zone,expected",
    [
        (6, "DOCUMENTOS", True),
        (2, "DOCUMENTOS", False),
        (4, "DOCUMENTOS", False),
        (0, "DOCUMENTOS", False),
        (6, "SISTEMA", False),
        (6, "PROGRAMAS", False),
        (6, None, False),
    ],
)
def test_hidden_system_user_file(attributes, zone, expected):
    assert (
        "HIDDEN_SYSTEM_USER_FILE"
        in codes(HeuristicsEngine(), context(attributes=attributes, zone=zone))
    ) == expected


@pytest.mark.parametrize(
    "content,expected",
    [
        ("# CYBERSOC_TEST_ENCODED_COMMAND", ["SCRIPT_ENCODED_COMMAND"]),
        ("powershell -EncodedCommand QUJD", ["SCRIPT_ENCODED_COMMAND"]),
        ("pwsh -enc QUJD", ["SCRIPT_ENCODED_COMMAND"]),
        ("A" * 220, ["SCRIPT_ENCODED_COMMAND"]),
        ("A" * 199, []),
        ("# invoke-webrequest and invoke-expression (names, no command)", ["SCRIPT_DOWNLOAD_EXEC"]),
        ("# DownloadString then Start-Process", ["SCRIPT_DOWNLOAD_EXEC"]),
        ("# invoke-webrequest only", []),
        ("# invoke-expression only", []),
        ("# benign comment", []),
    ],
)
@pytest.mark.parametrize("encoding", ["utf-8", "utf-16"])
def test_scripts_positive_negative_and_encoding(content, expected, encoding):
    data = content.encode(encoding)
    ctx = context(
        file=FileInfo(name="test.ps1", extension=".ps1", sizeBytes=len(data), modifiedAt="now"),
        sample=data,
        size_bytes=len(data),
    )
    findings = ScriptEngine().analyze(ctx)
    assert [item.code for item in findings] == expected
    assert all(
        item.points == 25 and item.severity == "HIGH" and not item.decisive for item in findings
    )
    assert all(content not in str(item.facts) for item in findings)


def test_scripts_bounded_and_non_script():
    assert codes(ScriptEngine(), context(sample=b"# CYBERSOC_TEST_ENCODED_COMMAND")) == []
    ctx = context(
        file=FileInfo(
            name="test.ps1", extension=".ps1", sizeBytes=SCRIPT_MAX_BYTES + 100, modifiedAt="now"
        ),
        sample=b" " * SCRIPT_MAX_BYTES + b"CYBERSOC_TEST_ENCODED_COMMAND",
    )
    assert codes(ScriptEngine(), ctx) == []
    sample = BoundedSample(10)
    for _ in range(100):
        sample.consume(b"a" * 1000)
    assert sample.data == b"a" * 10


def pe_context(**section):
    data = {
        "sections": [
            {"name": ".text", "entropy": 4, "writable": False, "executable": True, **section}
        ],
        "imports": [],
    }
    return context(prefix=b"MZ", pe_data=data)


@pytest.mark.parametrize(
    "section,expected",
    [
        ({"name": "UPX0"}, ["PE_PACKER_SECTION"]),
        ({"name": ".text"}, []),
        ({"writable": True}, ["PE_ANOMALOUS_SECTIONS"]),
        ({"writable": True, "executable": False}, []),
        ({"entropy": 7.20001}, ["PE_ANOMALOUS_SECTIONS"]),
        ({"entropy": 7.2}, []),
    ],
)
def test_pe_sections_positive_negative(section, expected):
    assert codes(PEEngine(), pe_context(**section)) == expected


@pytest.mark.parametrize("complete", [True, False])
def test_pe_suspicious_imports_requires_combination(complete):
    ctx = pe_context()
    ctx.pe_data["imports"] = ["OpenProcess", "VirtualAllocEx", "WriteProcessMemory"] + (
        ["CreateRemoteThread"] if complete else []
    )
    assert codes(PEEngine(), ctx) == (["PE_SUSPICIOUS_IMPORTS"] if complete else [])


def test_malformed_pe_yields_engine_error_and_next_file_runs(tmp_path):
    paths = generate_heuristic_fixtures(tmp_path)
    inspector = FileInspector()
    broken = inspector.inspect(
        str(paths[-1]), ScanFileOptions(maxBytes=PE_MAX_BYTES), task_id="broken"
    )
    assert broken.status == broken.verdict == "ERROR"
    assert broken.score is None and broken.scoreBreakdown is None
    error = next(e for e in broken.evidence if e.code == "ENGINE_ERROR")
    assert error.source == "ENGINE" and error.points == 0 and not error.decisive
    assert error.facts == {"layer": "PE", "reason": "PE_MALFORMED"}
    assert next(t for t in broken.layers if t.layer == "PE").status == "ERROR"
    for path, code in zip(paths[:2], ("HIGH_ENTROPY", "SCRIPT_ENCODED_COMMAND"), strict=True):
        result = inspector.inspect(
            str(path), ScanFileOptions(maxBytes=PE_MAX_BYTES), task_id="next"
        )
        assert result.status == "SCANNED" and result.verdict != "DETECTED"
        assert code in [e.code for e in result.evidence]
        assert [e.id for e in result.evidence] == [
            f"ev{i}" for i in range(1, len(result.evidence) + 1)
        ]


def test_byte_limit_never_invokes_pe_parser(tmp_path):
    path = tmp_path / "large.bin"
    path.write_bytes(b"MZ" + b"\0" * PE_MAX_BYTES)
    with patch(
        "cybersoc_engine.pipeline.inspect_pe", side_effect=AssertionError("must not parse")
    ) as parser:
        result = FileInspector().inspect(
            str(path), ScanFileOptions(maxBytes=PE_MAX_BYTES + 10), task_id="large"
        )
    parser.assert_not_called()
    assert next(t for t in result.layers if t.layer == "PE").reason == "PE_BYTE_LIMIT"


def test_real_timeout_terminates_auxiliary():
    real_run = subprocess.run

    def hanging_worker(_args, **kwargs):
        return real_run([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)

    started = perf_counter()
    with patch("cybersoc_engine.engines.pe_engine.subprocess.run", side_effect=hanging_worker):
        data, error, _ = inspect_pe(b"MZ", timeout=0.1)
    assert data is None and error == "PE_TIMEOUT"
    assert perf_counter() - started < 3


@pytest.mark.parametrize("name", ["notepad.exe", "whoami.exe", "cmd.exe"])
def test_readonly_copies_of_benign_system_executables(tmp_path, name):
    source = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / name
    if not source.is_file():
        pytest.skip("Ejecutable benigno de Windows no disponible")
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    modified = source.stat().st_mtime_ns
    copy = tmp_path / name
    shutil.copyfile(source, copy)
    result = FileInspector().inspect(
        str(copy), ScanFileOptions(maxBytes=PE_MAX_BYTES, zone="SISTEMA"), task_id="benign"
    )
    assert result.status == "SCANNED"
    assert result.verdict != "DETECTED"
    assert next(t for t in result.layers if t.layer == "PE").status == "RAN"
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
    assert source.stat().st_mtime_ns == modified
    assert hashlib.sha256(copy.read_bytes()).hexdigest() == before


def test_system_profile_disables_three_new_layers_without_parsing(tmp_path):
    path = tmp_path / "truncated.exe"
    path.write_bytes(b"MZ")
    with patch("cybersoc_engine.pipeline.inspect_pe", side_effect=AssertionError("disabled")):
        result = FileInspector().inspect(
            str(path),
            ScanFileOptions(
                maxBytes=100, zone="SISTEMA", layers=["HASH", "SIGNATURES", "FILETYPE"]
            ),
            task_id="system",
        )
    assert result.status == "SCANNED"
    for layer in ("HEURISTICS", "PE", "SCRIPTS"):
        trace = next(t for t in result.layers if t.layer == layer)
        assert trace.status == "DISABLED" and trace.reason == "PROFILE_DISABLED"


def test_pe_imports_are_shared_with_rules_and_parse_once(tmp_path):
    path = tmp_path / "fixture.bin"
    path.write_bytes(b"MZ")  # Cabecera inerte; el parser de esta prueba es simulado.
    rules = tmp_path / "rules"
    rules.mkdir()
    (rules / "imports.yaml").write_text(
        """id: R-TEST-IMPORTS
name: Prueba de imports
description: Datos simulados
severity: LOW
points: 5
decisive: false
conditions:
  peImports:
    all: [OpenProcess]
""",
        encoding="utf-8",
    )
    data = {"sections": [], "imports": ["OpenProcess"]}
    with (
        patch("cybersoc_engine.pipeline.default_rules", RuleStore(rules)),
        patch("cybersoc_engine.pipeline.inspect_pe", return_value=(data, None, 2)) as parser,
    ):
        result = FileInspector().inspect(
            str(path), ScanFileOptions(maxBytes=100), task_id="imports"
        )
    parser.assert_called_once()
    assert "R-TEST-IMPORTS" in [item.code for item in result.evidence]


def test_timeout_is_engine_error_in_trace(tmp_path):
    path = tmp_path / "fixture.bin"
    path.write_bytes(b"MZ")
    with patch("cybersoc_engine.pipeline.inspect_pe", return_value=(None, "PE_TIMEOUT", 2000)):
        result = FileInspector().inspect(
            str(path), ScanFileOptions(maxBytes=100), task_id="timeout"
        )
    trace = next(t for t in result.layers if t.layer == "PE")
    assert (trace.status, trace.reason) == ("ERROR", "PE_TIMEOUT")
    assert trace.ms >= 2000
    assert result.verdict == "ERROR"
