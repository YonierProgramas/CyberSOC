from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from cybersoc_engine.models import Evidence, FileInfo, Layer, Zone

if TYPE_CHECKING:
    from cybersoc_engine.engines.rule_engine import RuleCatalog


@dataclass(frozen=True)
class AnalysisContext:
    """Datos del mismo archivo abierto; las capas no necesitan abrir rutas."""

    file: FileInfo
    prefix: bytes
    sha256: str
    size_bytes: int = 0
    entropy: float = 0
    file_type: str | None = None
    pe_imports: tuple[str, ...] | None = None
    rule_catalog: "RuleCatalog | None" = None
    rule_matches: frozenset[str] = frozenset()
    zone: Zone | None = None
    attributes: int = 0
    sample: bytes = b""
    pe_data: dict | None = None
    pe_error: str | None = None
    pe_ms: float = 0


class DetectionEngine(Protocol):
    @property
    def layer_id(self) -> Layer: ...

    def analyze(self, ctx: AnalysisContext) -> list[Evidence]: ...
