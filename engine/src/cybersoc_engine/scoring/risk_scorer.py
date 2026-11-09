from dataclasses import dataclass
from typing import Literal

from cybersoc_engine.models import EngineResult, ScoreBreakdown, ScoreGroup

# Invariant: a severity has a fixed weight. Looking up the dict costs O(1)
# promedio; evaluar e evidencias cuesta O(e) tiempo y O(1) espacio auxiliar.
SEVERITY_POINTS = {"INFO": 0, "LOW": 5, "MEDIUM": 15, "HIGH": 25, "CRITICAL": 40}
type RiskLevel = Literal["BAJO", "MEDIO", "ALTO", "CRÍTICO"]
type EngineVerdict = Literal["CLEAN", "SUSPICIOUS", "DETECTED", "ERROR", "NOT_ANALYZED"]


@dataclass(frozen=True)
class RiskAssessment:
    verdict: EngineVerdict
    score: int | None
    riskLevel: RiskLevel | None
    scoreBreakdown: ScoreBreakdown | None = None


class RiskScorer:
    @staticmethod
    def classify(score: int, *, decisive: bool = False) -> RiskAssessment:
        """Pure thresholds to also check the 29/30 and 84/85 boundaries."""
        if type(score) is not int or score < 0:
            raise ValueError("The score must be a non-negative integer")
        score = min(score, 100)
        if decisive:
            score = max(score, 85)
        level: RiskLevel = (
            "BAJO" if score < 30 else "MEDIO" if score < 60 else "ALTO" if score < 85 else "CRÍTICO"
        )
        verdict: EngineVerdict = (
            "DETECTED" if decisive else "SUSPICIOUS" if score >= 30 else "CLEAN"
        )
        return RiskAssessment(verdict, score, level)

    def evaluate(self, result: EngineResult) -> RiskAssessment:
        # A conclusive signature is kept even if another layer fails afterwards.
        decisive = any(
            item.decisive and item.source in ("SIGNATURES", "RULES") for item in result.evidence
        )
        if not decisive:
            if result.status == "SKIPPED":
                return RiskAssessment("NOT_ANALYZED", None, None)
            if result.status == "ERROR" or any(layer.status == "ERROR" for layer in result.layers):
                return RiskAssessment("ERROR", None, None)
        # Invariant: three accumulators, one per group, keep the raw sum.
        # Dict: O(1) average per lookup; O(e) traversal, O(1) auxiliary memory.
        raw = {"heuristics": 0, "rules": 0, "signatures": 0}
        for item in result.evidence:
            if item.source == "ENGINE":
                continue  # A technical failure never adds malware risk.
            group = (
                "rules"
                if item.source == "RULES"
                else "signatures"
                if item.source == "SIGNATURES"
                else "heuristics"
            )
            raw[group] += SEVERITY_POINTS[item.severity]
        groups = {
            name: ScoreGroup(raw=raw[name], capped=min(raw[name], cap), cap=cap)
            for name, cap in (("heuristics", 50), ("rules", 60), ("signatures", 100))
        }
        capped = min(100, sum(group.capped for group in groups.values()))
        assessed = self.classify(capped, decisive=decisive)
        breakdown = ScoreBreakdown(
            version="2",
            **groups,
            rawTotal=sum(raw.values()),
            cappedTotal=capped,
            decisiveFloor=85 if decisive else 0,
            total=assessed.score,
        )
        return RiskAssessment(assessed.verdict, assessed.score, assessed.riskLevel, breakdown)
