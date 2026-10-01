import json
from copy import deepcopy
from pathlib import Path

import pytest
from pydantic import ValidationError
from test_risk_scorer import result_with

from cybersoc_engine.models import EngineResult, ScanFileResponse, ScoreBreakdown
from cybersoc_engine.scoring.risk_scorer import RiskScorer


def test_group_caps_total_and_breakdown():
    result = result_with(*(["HIGH"] * 8))
    for item in result.evidence[4:]:
        item.source = "RULES"
    assessed = RiskScorer().evaluate(result)
    assert assessed.verdict == "SUSPICIOUS" and assessed.score == 100
    breakdown = assessed.scoreBreakdown
    assert breakdown.heuristics.raw == 100 and breakdown.heuristics.capped == 50
    assert breakdown.rules.raw == 100 and breakdown.rules.capped == 60
    assert (breakdown.rawTotal, breakdown.cappedTotal, breakdown.total) == (200, 100, 100)
    assert ScoreBreakdown.model_validate_json(breakdown.model_dump_json()) == breakdown


@pytest.mark.parametrize("source", ["FILETYPE", "HEURISTICS", "PE", "SCRIPTS", "ENGINE"])
def test_only_signatures_and_rules_can_be_decisive(source):
    result = result_with(*(["CRITICAL"] * 10), decisive=True)
    for item in result.evidence:
        item.source = source
    assessed = RiskScorer().evaluate(result)
    assert assessed.verdict != "DETECTED"
    assert assessed.score <= 50


@pytest.mark.parametrize("source", ["RULES", "SIGNATURES"])
def test_valid_decisive_floor_is_explained(source):
    result = result_with("LOW", decisive=True)
    result.evidence[0].source = source
    assessed = RiskScorer().evaluate(result)
    assert assessed.verdict == "DETECTED" and assessed.score == 85
    assert assessed.scoreBreakdown.decisiveFloor == 85
    assert assessed.scoreBreakdown.cappedTotal == 5
    result.status = "ERROR"
    assert RiskScorer().evaluate(result).verdict == "DETECTED"


def test_optional_breakdown_retains_legacy_compatibility():
    result = result_with("HIGH")
    assert EngineResult.model_validate(result.model_dump(exclude_unset=True)).scoreBreakdown is None


@pytest.mark.parametrize("field", ["rawTotal", "cappedTotal", "total", "decisiveFloor", "version"])
def test_breakdown_required_fields_reject_deletion_and_wrong_totals(field):
    breakdown = RiskScorer().evaluate(result_with("HIGH")).scoreBreakdown.model_dump()
    bad = deepcopy(breakdown)
    del bad[field]
    with pytest.raises(ValidationError):
        ScoreBreakdown.model_validate(bad)
    bad[field] = 99
    with pytest.raises(ValidationError):
        ScoreBreakdown.model_validate(bad)


def test_shared_v2_example():
    path = (
        Path(__file__).resolve().parents[2]
        / "contracts/protocol-v1/scan.file.response.score-v2.json"
    )
    raw = json.loads(path.read_text(encoding="utf-8"))
    parsed = ScanFileResponse.model_validate(raw)
    assert parsed.result.scoreBreakdown.total == parsed.result.score == 100
    raw["result"]["score"] = 99
    with pytest.raises(ValidationError):
        ScanFileResponse.model_validate(raw)
