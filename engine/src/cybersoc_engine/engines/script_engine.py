import re
from typing import Literal

from cybersoc_engine.engines.base import AnalysisContext
from cybersoc_engine.engines.filetype_engine import SCRIPT_EXTENSIONS
from cybersoc_engine.engines.heuristics_engine import finding
from cybersoc_engine.models import Evidence

SCRIPT_MAX_BYTES = 1024 * 1024
ENCODED = re.compile(r"(?:^|\s)-(?:encodedcommand|enc|e)(?:\s|$)", re.IGNORECASE)
BLOB = re.compile(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{200,}={0,2}")
DOWNLOAD = re.compile(
    r"\b(?:invoke-webrequest|invoke-restmethod|iwr|downloadstring|downloadfile)\b", re.I
)
EXECUTE = re.compile(r"\b(?:invoke-expression|iex|start-process)\b", re.I)


class ScriptEngine:
    layer_id: Literal["SCRIPTS"] = "SCRIPTS"

    def skip_reason(self, ctx: AnalysisContext) -> str | None:
        return None if (ctx.file.extension or "").lower() in SCRIPT_EXTENSIONS else "NOT_SCRIPT"

    def analyze(self, ctx: AnalysisContext) -> list[Evidence]:
        if self.skip_reason(ctx):
            return []
        data = ctx.sample[:SCRIPT_MAX_BYTES]
        encoding = "utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
        text = data.decode(encoding, errors="replace")
        findings = []
        powershell = (ctx.file.extension or "").lower() in (".ps1", ".psm1") or bool(
            re.search(r"\b(?:powershell|pwsh)(?:\.exe)?\b", text, re.I)
        )
        if (
            (powershell and ENCODED.search(text))
            or BLOB.search(text)
            or "CYBERSOC_TEST_ENCODED_COMMAND" in text
        ):
            findings.append(
                finding(
                    self.layer_id,
                    "SCRIPT_ENCODED_COMMAND",
                    "Indicador de comando codificado",
                    "HIGH",
                    25,
                    {
                        "maxScanBytes": SCRIPT_MAX_BYTES,
                        "truncated": ctx.size_bytes > SCRIPT_MAX_BYTES,
                    },
                )
            )
        if DOWNLOAD.search(text) and EXECUTE.search(text):
            findings.append(
                finding(
                    self.layer_id,
                    "SCRIPT_DOWNLOAD_EXEC",
                    "Indicadores de descarga y ejecución",
                    "HIGH",
                    25,
                    {
                        "maxScanBytes": SCRIPT_MAX_BYTES,
                        "truncated": ctx.size_bytes > SCRIPT_MAX_BYTES,
                    },
                )
            )
        # Solo detección textual: no evalúa scripts ni decodifica/ejecuta comandos.
        return findings
