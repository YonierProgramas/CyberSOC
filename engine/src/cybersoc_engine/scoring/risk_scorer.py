from dataclasses import dataclass
from typing import Literal

from cybersoc_engine.models import EngineResult

# Invariante: una severidad tiene un peso fijo. Consultar el dict cuesta O(1)
# promedio; evaluar e evidencias cuesta O(e) tiempo y O(1) espacio auxiliar.
SEVERITY_POINTS = {"INFO": 0, "LOW": 5, "MEDIUM": 15, "HIGH": 25, "CRITICAL": 40}
type RiskLevel = Literal["BAJO", "MEDIO", "ALTO", "CRÍTICO"]
type EngineVerdict = Literal["CLEAN", "SUSPICIOUS", "DETECTED", "ERROR", "NOT_ANALYZED"]


@dataclass(frozen=True)
class RiskAssessment:
    verdict: EngineVerdict
    score: int | None
    riskLevel: RiskLevel | None


class RiskScorer:
    @staticmethod
    def classify(score: int, *, decisive: bool = False) -> RiskAssessment:
        """Umbrales puros para comprobar también las fronteras 29/30 y 84/85."""
        if type(score) is not int or score < 0:
            raise ValueError("La puntuación debe ser un entero no negativo")
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
        # Una firma concluyente se conserva incluso si falla otra capa después.
        decisive = any(item.decisive for item in result.evidence)
        if not decisive:
            if result.status == "SKIPPED":
                return RiskAssessment("NOT_ANALYZED", None, None)
            if result.status == "ERROR" or any(layer.status == "ERROR" for layer in result.layers):
                return RiskAssessment("ERROR", None, None)
        score = sum(SEVERITY_POINTS[item.severity] for item in result.evidence)
        return self.classify(score, decisive=decisive)
