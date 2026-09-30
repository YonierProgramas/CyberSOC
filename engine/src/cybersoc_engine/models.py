from typing import Annotated, Literal

from pydantic import Field, JsonValue, field_validator

from cybersoc_engine.rpc.protocol import ContractEnvelope, ContractModel

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
    evidence: list[JsonValue]
    error: FileError | None = None
    durationMs: float
    engineVersion: str

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
