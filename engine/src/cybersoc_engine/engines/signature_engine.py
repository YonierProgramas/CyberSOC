import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import ConfigDict, Field

from cybersoc_engine.engines.base import AnalysisContext
from cybersoc_engine.models import Evidence
from cybersoc_engine.rpc.protocol import ContractModel

DEFAULT_SIGNATURES = Path(__file__).resolve().parents[3] / "data" / "signatures"


class Signature(ContractModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)
    id: Annotated[str, Field(min_length=1)]
    title: Annotated[str, Field(min_length=1)]
    sha256: Annotated[str, Field(pattern=r"^[a-fA-F0-9]{64}$")]
    testOnly: bool
    sourceUrl: str | None = None


class SignatureFile(ContractModel):
    version: Annotated[str, Field(min_length=1)]
    signatures: list[Signature]


class SignatureCatalog:
    def __init__(self, directory: Path = DEFAULT_SIGNATURES) -> None:
        paths = sorted(directory.glob("*.json"))
        if not paths:
            raise ValueError("No hay archivos de firmas locales")
        # Invariante: cada hash normalizado identifica una sola firma. Construir
        # el dict cuesta O(n) promedio; buscar con get cuesta O(1) promedio,
        # frente a O(n) para recorrer una lista. Ocupa O(n) memoria.
        self._by_hash: dict[str, Signature] = {}
        # El set impide IDs repetidos entre archivos: consulta/add O(1) promedio.
        ids: set[str] = set()
        digest = hashlib.sha256()
        for path in paths:
            content = path.read_bytes()
            document = SignatureFile.model_validate_json(content)
            canonical = json.dumps(
                document.model_dump(exclude_none=True), sort_keys=True, separators=(",", ":")
            ).encode()
            digest.update(path.name.encode("utf-8") + b"\0" + canonical + b"\0")
            for signature in document.signatures:
                key = signature.sha256.lower()
                if key in self._by_hash or signature.id in ids:
                    raise ValueError("Hash o ID de firma duplicado")
                self._by_hash[key] = signature.model_copy(update={"sha256": key})
                ids.add(signature.id)
        # La versión identifica los datos cargados, no su ubicación ni los saltos
        # de línea de Windows/Linux. No cambia por reformatear el JSON.
        self.version = "sha256:" + digest.hexdigest()

    @property
    def count(self) -> int:
        return len(self._by_hash)

    def find(self, sha256: str) -> Signature | None:
        # Hash de longitud fija (64): normalización y consulta O(1) promedio.
        return self._by_hash.get(sha256.lower())


@lru_cache(maxsize=1)
def default_catalog() -> SignatureCatalog:
    # Solo se conserva el catálogo de referencia; nunca resultados de archivos.
    # Se carga una vez por proceso. Reiniciar el motor aplica cambios del catálogo.
    return SignatureCatalog()


class SignatureEngine:
    layer_id: Literal["SIGNATURES"] = "SIGNATURES"

    def __init__(self, catalog: SignatureCatalog | None = None) -> None:
        self._catalog = catalog

    def analyze(self, ctx: AnalysisContext) -> list[Evidence]:
        catalog = self._catalog if self._catalog is not None else default_catalog()
        signature = catalog.find(ctx.sha256)
        if signature is None:
            return []
        return [
            Evidence(
                id="ev1",
                source=self.layer_id,
                code="SIGNATURE_MATCH",
                title=signature.title,
                severity="CRITICAL",
                points=40,
                decisive=True,
                confidence=1,
                facts={
                    "signatureId": signature.id,
                    "sha256": ctx.sha256.lower(),
                    "testOnly": signature.testOnly,
                    "signaturesVersion": catalog.version,
                },
            )
        ]
