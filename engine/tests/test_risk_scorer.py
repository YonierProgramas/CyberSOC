import pytest

from cybersoc_engine.models import EngineResult, Evidence, LayerTrace
from cybersoc_engine.scoring.risk_scorer import RiskScorer


def result_with(*severities, decisive=False, status="SCANNED"):
    return EngineResult(
        taskId="t",
        status=status,
        evidence=[
            Evidence(
                id=f"ev{i}",
                source="SIGNATURES" if decisive else "FILETYPE",
                code="TEST",
                title="Prueba",
                severity=severity,
                points=0,
                decisive=decisive,
                confidence=1,
                facts={},
            )
            for i, severity in enumerate(severities, 1)
        ],
        layers=[],
        durationMs=0,
        engineVersion="test",
    )


@pytest.mark.parametrize(
    "severity,score", [("INFO", 0), ("LOW", 5), ("MEDIUM", 15), ("HIGH", 25), ("CRITICAL", 40)]
)
def test_scores_use_severity_not_arbitrary_points(severity, score):
    result = result_with(severity)
    result.evidence[0].points = 99
    assert RiskScorer().evaluate(result).score == score


@pytest.mark.parametrize(
    "score,verdict,level",
    [
        (0, "CLEAN", "BAJO"),
        (29, "CLEAN", "BAJO"),
        (30, "SUSPICIOUS", "MEDIO"),
        (59, "SUSPICIOUS", "MEDIO"),
        (60, "SUSPICIOUS", "ALTO"),
        (84, "SUSPICIOUS", "ALTO"),
        (85, "SUSPICIOUS", "CRÍTICO"),
        (100, "SUSPICIOUS", "CRÍTICO"),
        (120, "SUSPICIOUS", "CRÍTICO"),
    ],
)
def test_thresholds_and_levels(score, verdict, level):
    assessment = RiskScorer.classify(score)
    assert (assessment.verdict, assessment.score, assessment.riskLevel) == (
        verdict,
        min(score, 100),
        level,
    )


def test_sum_cap_and_decisive_floor():
    scorer = RiskScorer()
    assert scorer.evaluate(result_with()).score == 0
    assert scorer.evaluate(result_with("MEDIUM", "MEDIUM")).verdict == "SUSPICIOUS"
    assert scorer.evaluate(result_with("CRITICAL", "CRITICAL", "CRITICAL")).score == 100
    for severities, score in [(("CRITICAL",), 85), (("CRITICAL", "CRITICAL", "CRITICAL"), 100)]:
        assessment = scorer.evaluate(result_with(*severities, decisive=True))
        assert (assessment.verdict, assessment.score, assessment.riskLevel) == (
            "DETECTED",
            score,
            "CRÍTICO",
        )


@pytest.mark.parametrize("status,verdict", [("ERROR", "ERROR"), ("SKIPPED", "NOT_ANALYZED")])
def test_unanalysed_is_never_clean(status, verdict):
    assessment = RiskScorer().evaluate(result_with("HIGH", status=status))
    assert (assessment.verdict, assessment.score, assessment.riskLevel) == (verdict, None, None)


def test_layer_error_prevents_clean_assessment():
    result = result_with()
    result.layers = [
        LayerTrace(layer="SIGNATURES", status="ERROR", reason="FAILED", hits=0, points=0, ms=0)
    ]
    assert RiskScorer().evaluate(result).verdict == "ERROR"


@pytest.mark.parametrize("score", [-1, 1.5, "30", True])
def test_invalid_score(score):
    with pytest.raises(ValueError):
        RiskScorer.classify(score)
