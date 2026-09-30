from typing import Annotated, Literal

from pydantic import BeforeValidator, Field, JsonValue, field_validator, model_validator

from cybersoc_engine.rpc.protocol import ContractEnvelope, ContractModel, EmptyParams

type EvidenceSource = Literal[
    "SIGNATURES", "FILETYPE", "RULES", "HEURISTICS", "PE", "SCRIPTS", "ENGINE"
]
type Layer = Literal["HASH", "SIGNATURES", "FILETYPE", "RULES", "HEURISTICS", "PE", "SCRIPTS"]


def json_integer(value: object) -> object:
    # JSON/JavaScript no distingue 1 de 1.0; no convertir cadenas ni booleanos.
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


type NonNegativeInt = Annotated[
    int, Field(ge=0, le=9007199254740991), BeforeValidator(json_integer)
]


class StatsRequest(ContractEnvelope):
    method: Literal["engine.stats"]
    params: EmptyParams


class StatsResult(ContractModel):
    engineVersion: Annotated[str, Field(min_length=1)]
    signaturesVersion: Annotated[str, Field(min_length=1)]
    signaturesCount: NonNegativeInt


class StatsResponse(ContractEnvelope):
    result: StatsResult


class Evidence(ContractModel):
    id: Annotated[str, Field(pattern=r"^ev[1-9][0-9]*$")]
    source: EvidenceSource
    code: Annotated[str, Field(min_length=1)]
    title: Annotated[str, Field(min_length=1)]
    severity: Literal["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]
    points: NonNegativeInt
    decisive: bool
    confidence: Annotated[float, Field(ge=0, le=1)]
    # Diccionario de hechos: claves únicas; acceso promedio O(1), validación O(n).
    facts: dict[str, JsonValue]


class LayerTrace(ContractModel):
    layer: Layer
    status: Literal["RAN", "SKIPPED", "DISABLED", "ERROR"]
    reason: Annotated[str, Field(pattern=r"\S")] | None = None
    hits: NonNegativeInt
    points: NonNegativeInt
    ms: Annotated[float, Field(ge=0)]

    @field_validator("reason", mode="before")
    @classmethod
    def reject_null_reason(cls, value: object) -> object:
        if value is None:
            raise ValueError("Omit reason instead of sending null")
        return value

    @model_validator(mode="after")
    def validate_status(self) -> "LayerTrace":
        if self.status == "SKIPPED" and self.reason is None:
            raise ValueError("SKIPPED requiere reason")
        if self.layer == "HASH" and self.status == "DISABLED":
            raise ValueError("HASH no se puede desactivar")
        return self


type FileScanStatus = Literal["SCANNED", "ERROR", "SKIPPED"]
type FileErrorCode = Literal[
    "FILE_NOT_FOUND",
    "ACCESS_DENIED",
    "FILE_LOCKED",
    "IO_ERROR",
    "TOO_LARGE",
    "CLOUD_PLACEHOLDER",
    "TIMEOUT",
    "ENGINE_CRASHED",
]


class FileTask(ContractModel):
    jobId: str
    taskId: str
    seq: float
    path: str


class ScanFileOptions(ContractModel):
    maxBytes: float


class ScanFileParams(ContractModel):
    jobId: str
    taskId: str
    path: str
    options: ScanFileOptions


class FileInfo(ContractModel):
    name: str
    extension: str | None
    sizeBytes: float
    modifiedAt: str


class FileHashes(ContractModel):
    sha256: Annotated[str, Field(min_length=64, max_length=64, pattern=r"^[a-fA-F0-9]{64}$")]


class FileError(ContractModel):
    code: FileErrorCode
    message: str


class EngineResult(ContractModel):
    taskId: str
    status: FileScanStatus
    file: FileInfo | None = None
    hashes: FileHashes | None = None
    evidence: list[Evidence]
    layers: list[LayerTrace]
    error: FileError | None = None
    durationMs: float
    engineVersion: str

    @field_validator("layers")
    @classmethod
    def unique_layers(cls, layers: list[LayerTrace]) -> list[LayerTrace]:
        # Invariante: el set contiene solo capas ya vistas, sin repetidas.
        # Pertenencia/add: O(1) promedio; recorrido: O(n) tiempo y espacio.
        seen: set[str] = set()
        for trace in layers:
            if trace.layer in seen:
                raise ValueError("Capa repetida")
            seen.add(trace.layer)
        return layers

    @field_validator("file", "hashes", "error", mode="before")
    @classmethod
    def reject_explicit_null(cls, value: object) -> object:
        # TS optional means absent, not null. Serialize with exclude_unset=True.
        if value is None:
            raise ValueError("Omit optional fields instead of sending null")
        return value


class ScanFileRequest(ContractEnvelope):
    method: Literal["scan.file"]
    params: ScanFileParams


class ScanFileResponse(ContractEnvelope):
    result: EngineResult
