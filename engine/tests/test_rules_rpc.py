import json
from io import BytesIO
from unittest.mock import patch

import pytest
from fixtures.generate import generate_rule_fixtures, generate_signature_fixtures
from test_pipeline import result_for
from test_process import engine_process
from test_rule_engine import write_rule

from cybersoc_engine.engines.rule_engine import RuleStore, classify_file_type
from cybersoc_engine.models import RulesReloadResponse, ScanFileResponse, StatsResponse
from cybersoc_engine.pipeline import AnalysisPipeline
from cybersoc_engine.rpc.server import handle_line


def rpc(method, params=None, id=1):
    return json.loads(
        handle_line(
            json.dumps(
                {"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}}
            ).encode()
        ).response
    )


def scan(path, layers=None):
    options = {"maxBytes": 10 * 1024 * 1024}
    if layers is not None:
        options["layers"] = layers
    return ScanFileResponse.model_validate(
        rpc("scan.file", {"jobId": "j", "taskId": "t", "path": str(path), "options": options})
    ).result


def test_generated_rules_through_real_pipeline_are_harmless_and_deterministic(tmp_path):
    paths = generate_rule_fixtures(tmp_path)
    expected = ["R-TEST-DOWNLOADER", "R-TEST-PAIR", "R-TEST-UTF16", "R-TEST-HEX"]
    for path, code in zip(paths, expected, strict=True):
        before = path.read_bytes()
        mtime = path.stat().st_mtime_ns
        result = scan(path)
        assert result.status == "SCANNED"
        assert [e.code for e in result.evidence] == [code]
        assert result.evidence[0].id == "ev1"
        assert result.evidence[0].source == "RULES"
        assert result.layers[-1].layer == "RULES" and result.layers[-1].status == "RAN"
        assert result.layers[-1].hits == 1
        assert result.layers[-1].points == result.evidence[0].points
        assert result.verdict == ("DETECTED" if code == "R-TEST-HEX" else "CLEAN")
        assert path.read_bytes() == before
        assert path.stat().st_mtime_ns == mtime
        disabled = scan(path, layers=["FILETYPE"])
        assert disabled.evidence == []
        assert disabled.layers[-1].status == "DISABLED"
        assert disabled.layers[-1].ms == disabled.layers[-1].points == disabled.layers[-1].hits == 0


def test_disabled_rules_do_not_load_catalog(tmp_path):
    path = generate_rule_fixtures(tmp_path)[0]
    with patch(
        "cybersoc_engine.pipeline.default_rules.current", side_effect=AssertionError("disabled")
    ) as load:
        assert scan(path, layers=[]).layers[-1].status == "DISABLED"
    load.assert_not_called()


def test_bad_catalog_marks_rules_error_but_preserves_hash_and_signature(tmp_path):
    generate_signature_fixtures(tmp_path)
    store = RuleStore(tmp_path / "missing")
    with patch("cybersoc_engine.pipeline.default_rules", store):
        result = scan(tmp_path / "CSD-TEST-001.txt")
    assert result.status == "ERROR" and result.verdict == "DETECTED"
    assert result.hashes is not None
    assert result.layers[-1].status == "ERROR"
    assert result.layers[-1].reason == "RULESET_INVALID"


def test_ids_stay_stable_across_filetype_and_rules():
    result = result_for("factura.pdf.exe")
    AnalysisPipeline().analyze(BytesIO(b"CYBERSOC_TEST_HEX"), result)
    assert [(e.id, e.source) for e in result.evidence] == [("ev1", "FILETYPE"), ("ev2", "RULES")]


def test_rules_reload_rpc_applies_changes_and_rejects_invalid_without_losing_current(
    tmp_path, caplog
):
    rule = write_rule(tmp_path, {"strings": {"any": ["FIRST"]}})
    sample = tmp_path / "sample.txt"
    sample.write_bytes(b"FIRST")
    store = RuleStore(tmp_path)
    with (
        patch("cybersoc_engine.rpc.handlers.default_rules", store),
        patch("cybersoc_engine.pipeline.default_rules", store),
    ):
        first = RulesReloadResponse.model_validate(rpc("rules.reload")).result
        assert first.rulesCount == 1
        assert scan(sample).evidence
        rule.write_text("bad: [", encoding="utf-8")
        assert rpc("rules.reload")["error"]["code"] == -32603
        assert "Regla inválida en rule.yaml" in caplog.text
        assert (
            StatsResponse.model_validate(rpc("engine.stats")).result.rulesetVersion
            == first.rulesetVersion
        )
        assert scan(sample).evidence
        write_rule(tmp_path, {"strings": {"any": ["SECOND"]}})
        second = RulesReloadResponse.model_validate(rpc("rules.reload")).result
        assert second.rulesetVersion != first.rulesetVersion
        assert scan(sample).evidence == []
        assert (
            StatsResponse.model_validate(rpc("engine.stats")).result.rulesetVersion
            == second.rulesetVersion
        )


@pytest.mark.parametrize("params", [[], [1], {"path": "other"}, {"extra": True}])
def test_reload_rejects_params_without_loading(params):
    with patch("cybersoc_engine.rpc.handlers.default_rules.reload") as reload:
        response = handle_line(
            json.dumps(
                {"jsonrpc": "2.0", "id": 1, "method": "rules.reload", "params": params}
            ).encode()
        )
    assert json.loads(response.response)["error"]["code"] == -32602
    reload.assert_not_called()


@pytest.mark.parametrize(
    "prefix,extension,expected",
    [
        (b"MZ", ".pdf", "PE"),
        (b"%PDF", ".exe", "PDF"),
        (b"abc", ".PS1", "SCRIPT_PS1"),
        (b"abc", ".txt", "TEXT"),
        (b"\0\xff", ".ps1", None),
        (b"", ".txt", None),
    ],
)
def test_rule_filetypes_use_content(prefix, extension, expected):
    assert classify_file_type(prefix, extension) == expected


def test_real_process_reload_stats_and_rule_scan(tmp_path):
    path = generate_rule_fixtures(tmp_path)[3]
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "rules.reload", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "engine.stats", "params": {}},
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "scan.file",
            "params": {
                "jobId": "j",
                "taskId": "t",
                "path": str(path),
                "options": {"maxBytes": 1024},
            },
        },
    ]
    with engine_process() as process:
        stdout, _ = process.communicate(
            ("\n".join(json.dumps(m) for m in messages) + "\n").encode(), timeout=10
        )
        assert process.returncode == 0
    values = [json.loads(line) for line in stdout.splitlines()]
    reload = RulesReloadResponse.model_validate(values[0])
    stats = StatsResponse.model_validate(values[1])
    scan_result = ScanFileResponse.model_validate(values[2])
    assert reload.result.rulesCount == 4
    assert reload.result.rulesetVersion == stats.result.rulesetVersion
    assert scan_result.result.verdict == "DETECTED"
    assert scan_result.result.evidence[0].facts["rulesetVersion"] == stats.result.rulesetVersion
