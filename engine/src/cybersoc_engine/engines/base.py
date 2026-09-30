from dataclasses import dataclass
from typing import Protocol

from cybersoc_engine.models import Evidence, FileInfo, Layer


@dataclass(frozen=True)
class AnalysisContext:
    """Datos del mismo archivo abierto; las capas no necesitan abrir rutas."""

    file: FileInfo
    prefix: bytes
    sha256: str


class DetectionEngine(Protocol):
    @property
    def layer_id(self) -> Layer: ...

    def analyze(self, ctx: AnalysisContext) -> list[Evidence]: ...
