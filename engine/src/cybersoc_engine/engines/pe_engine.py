import json
import os
import subprocess
import sys
from pathlib import Path
from time import perf_counter
from typing import Literal

from cybersoc_engine.analysis.pe_worker import PE_MAX_BYTES
from cybersoc_engine.engines.base import AnalysisContext
from cybersoc_engine.engines.heuristics_engine import finding
from cybersoc_engine.models import Evidence

PE_TIMEOUT_SECONDS = 2.0


def inspect_pe(
    data: bytes, *, timeout: float = PE_TIMEOUT_SECONDS
) -> tuple[dict | None, str | None, float]:
    started = perf_counter()
    if len(data) > PE_MAX_BYTES:
        return None, "PE_BYTE_LIMIT", 0
    env = dict(os.environ)
    env.pop("CYBERSOC_ANTHROPIC_API_KEY", None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    try:
        # Timeout real: subprocess.run mata y recoge el auxiliar al vencer.
        # No se inicia el archivo analizado: solo nuestro módulo fijo recibe bytes.
        completed = subprocess.run(
            [sys.executable, "-m", "cybersoc_engine.analysis.pe_worker"],
            input=data,
            capture_output=True,
            timeout=timeout,
            check=True,
            env=env,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        message = json.loads(completed.stdout)
        return message.get("data"), message.get("error"), (perf_counter() - started) * 1000
    except subprocess.TimeoutExpired:
        return None, "PE_TIMEOUT", (perf_counter() - started) * 1000
    except (OSError, subprocess.SubprocessError, ValueError):
        return None, "PE_WORKER_ERROR", (perf_counter() - started) * 1000


class PEEngine:
    layer_id: Literal["PE"] = "PE"

    def skip_reason(self, ctx: AnalysisContext) -> str | None:
        if not ctx.prefix.startswith(b"MZ"):
            return "NOT_PE"
        if ctx.size_bytes > PE_MAX_BYTES:
            return "PE_BYTE_LIMIT"
        return None

    def analyze(self, ctx: AnalysisContext) -> list[Evidence]:
        if self.skip_reason(ctx):
            return []
        if ctx.pe_error:
            return [
                finding(
                    "ENGINE",
                    "ENGINE_ERROR",
                    "No se completó el análisis PE",
                    "INFO",
                    0,
                    {"layer": "PE", "reason": ctx.pe_error},
                )
            ]
        if ctx.pe_data is None:
            raise ValueError("Missing PE analysis")
        findings = []
        sections = ctx.pe_data["sections"]
        packed = [
            s["name"]
            for s in sections
            if s["name"].casefold().startswith(("upx", ".aspack", ".adata", "mpress"))
        ]
        anomalous = [
            s["name"] for s in sections if (s["writable"] and s["executable"]) or s["entropy"] > 7.2
        ]
        if packed:
            findings.append(
                finding(
                    self.layer_id,
                    "PE_PACKER_SECTION",
                    "Secciones de empaquetador",
                    "LOW",
                    5,
                    {"sections": packed},
                )
            )
        if anomalous:
            findings.append(
                finding(
                    self.layer_id,
                    "PE_ANOMALOUS_SECTIONS",
                    "Secciones PE anómalas",
                    "MEDIUM",
                    15,
                    {"sections": anomalous},
                )
            )
        # Invariante: imports únicos normalizados; construir O(i), consultar O(1)
        # promedio. La combinación exige acceso, escritura y ejecución remotas.
        imports = {name.casefold() for name in ctx.pe_data["imports"]}
        if {"openprocess", "virtualallocex", "writeprocessmemory"} <= imports and imports & {
            "createremotethread",
            "ntcreatethreadex",
        }:
            findings.append(
                finding(
                    self.layer_id,
                    "PE_SUSPICIOUS_IMPORTS",
                    "Combinación de APIs de inyección",
                    "MEDIUM",
                    15,
                    {"combination": "remote-process-write-execute"},
                )
            )
        return findings
