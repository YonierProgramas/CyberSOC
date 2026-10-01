from time import perf_counter
from typing import BinaryIO

from cybersoc_engine.analysis.hashing import sha256_stream
from cybersoc_engine.engines.base import AnalysisContext, DetectionEngine
from cybersoc_engine.engines.filetype_engine import FileTypeEngine
from cybersoc_engine.engines.signature_engine import SignatureEngine
from cybersoc_engine.errors import map_file_error
from cybersoc_engine.models import EngineResult, FileError, FileHashes, Layer, LayerTrace

PREFIX_BYTES = 4096


class AnalysisPipeline:
    def __init__(self) -> None:
        self.engines: tuple[DetectionEngine, ...] = (SignatureEngine(), FileTypeEngine())

    def analyze(
        self, stream: BinaryIO, result: EngineResult, layers: list[Layer] | None = None
    ) -> None:
        """Ejecuta HASH, SIGNATURES y FILETYPE sin volver a abrir la ruta."""
        started = perf_counter()
        try:
            result.hashes = FileHashes(sha256=sha256_stream(stream))
        except (OSError, ValueError) as error:
            reason = map_file_error(error).code if isinstance(error, OSError) else "IO_ERROR"
            result.layers.append(
                LayerTrace(
                    layer="HASH",
                    status="ERROR",
                    reason=reason,
                    hits=0,
                    points=0,
                    ms=(perf_counter() - started) * 1000,
                )
            )
            raise
        result.layers.append(
            LayerTrace(
                layer="HASH",
                status="RAN",
                hits=0,
                points=0,
                ms=(perf_counter() - started) * 1000,
            )
        )
        result.status = "SCANNED"
        for engine in self.engines:
            if self.disabled(engine.layer_id, layers):
                result.layers.append(self.disabled_trace(engine.layer_id))
                continue
            started = perf_counter()
            try:
                # Releer solo una muestra acotada evita abrir otra vez la ruta y
                # cargar el archivo entero en memoria. El descriptor sigue abierto.
                prefix = b""
                if engine.layer_id == "FILETYPE":
                    stream.seek(0)
                    prefix = stream.read(PREFIX_BYTES)
                ctx = AnalysisContext(file=result.file, prefix=prefix, sha256=result.hashes.sha256)
                findings = engine.analyze(ctx)
                # La lista conserva el orden de capas/hallazgos. Recorrer e
                # evidencias cuesta O(e); append cuesta O(1) amortizado.
                findings = [
                    item.model_copy(update={"id": f"ev{len(result.evidence) + i}"})
                    for i, item in enumerate(findings, start=1)
                ]
                result.evidence.extend(findings)
                result.layers.append(
                    LayerTrace(
                        layer=engine.layer_id,
                        status="RAN",
                        hits=len(findings),
                        points=sum(item.points for item in findings),
                        ms=(perf_counter() - started) * 1000,
                    )
                )
            except Exception:
                # El fallo de una capa no borra el hash ni termina el servidor.
                # No exponer mensajes de excepciones que puedan contener rutas.
                result.status = "ERROR"
                result.error = FileError(
                    code="IO_ERROR", message="No se completó una capa de análisis"
                )
                result.layers.append(
                    LayerTrace(
                        layer=engine.layer_id,
                        status="ERROR",
                        reason="ANALYSIS_ERROR",
                        hits=0,
                        points=0,
                        ms=(perf_counter() - started) * 1000,
                    )
                )

    @staticmethod
    def disabled(layer: Layer, layers: list[Layer] | None) -> bool:
        # La lista es acotada a siete capas: pertenencia O(k), sin cambiar su orden.
        return layers is not None and layer not in ("HASH", "SIGNATURES") and layer not in layers

    @staticmethod
    def disabled_trace(layer: Layer) -> LayerTrace:
        return LayerTrace(
            layer=layer, status="DISABLED", reason="PROFILE_DISABLED", hits=0, points=0, ms=0
        )

    def complete_skipped(self, result: EngineResult, layers: list[Layer] | None = None) -> None:
        # Invariante: el set contiene las capas que ya tienen traza. Crear el set
        # cuesta O(n); consultar pertenencia O(1) promedio; completar cuesta O(n).
        recorded = {trace.layer for trace in result.layers}
        for layer in ("HASH", *(engine.layer_id for engine in self.engines)):
            if layer not in recorded:
                if self.disabled(layer, layers):
                    result.layers.append(self.disabled_trace(layer))
                    recorded.add(layer)
                    continue
                result.layers.append(
                    LayerTrace(
                        layer=layer,
                        status="SKIPPED",
                        reason=result.error.code if result.error else "NOT_ANALYZED",
                        hits=0,
                        points=0,
                        ms=0,
                    )
                )
                recorded.add(layer)
