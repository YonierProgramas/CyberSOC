from typing import Literal

from cybersoc_engine.engines.base import AnalysisContext
from cybersoc_engine.engines.filetype_engine import detect_type
from cybersoc_engine.models import Evidence


def finding(source, code, title, severity, points, facts) -> Evidence:
    return Evidence(
        id="ev1",
        source=source,
        code=code,
        title=title,
        severity=severity,
        points=points,
        decisive=False,
        confidence=0.7,
        facts=facts,
    )


class HeuristicsEngine:
    layer_id: Literal["HEURISTICS"] = "HEURISTICS"

    def analyze(self, ctx: AnalysisContext) -> list[Evidence]:
        findings = []
        if ctx.entropy > 7.2:
            findings.append(
                finding(
                    self.layer_id,
                    "HIGH_ENTROPY",
                    "Entropía global elevada",
                    "MEDIUM",
                    15,
                    {"entropy": ctx.entropy, "threshold": 7.2},
                )
            )
        detected = detect_type(ctx.prefix, ctx.file.extension)
        if detected and detected.executable and ctx.zone in ("DESCARGAS", "TEMPORALES"):
            findings.append(
                finding(
                    self.layer_id,
                    "EXEC_IN_DOWNLOADS_OR_TEMP",
                    "Ejecutable en Descargas o temporales",
                    "LOW",
                    5,
                    {"zone": ctx.zone, "detectedType": detected.name},
                )
            )
        if ctx.attributes & 6 == 6 and ctx.zone in (
            "DESCARGAS",
            "ESCRITORIO",
            "DOCUMENTOS",
            "TEMPORALES",
            "DATOS_APPS",
            "EXTRAIBLE",
        ):
            findings.append(
                finding(
                    self.layer_id,
                    "HIDDEN_SYSTEM_USER_FILE",
                    "Archivo de usuario oculto y de sistema",
                    "LOW",
                    5,
                    {"zone": ctx.zone, "hidden": True, "system": True},
                )
            )
        return findings
