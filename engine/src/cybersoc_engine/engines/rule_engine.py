import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Annotated, Literal

import yaml
from pydantic import ConfigDict, Field, ValidationError, model_validator

from cybersoc_engine.engines.base import AnalysisContext
from cybersoc_engine.engines.filetype_engine import detect_type, is_text
from cybersoc_engine.models import Evidence
from cybersoc_engine.rpc.protocol import ContractModel
from cybersoc_engine.scoring.risk_scorer import SEVERITY_POINTS

DEFAULT_RULES = Path(__file__).resolve().parents[3] / "data" / "rules"
MAX_RULE_BYTES = 1024 * 1024
MAX_SCAN_BYTES = 16 * 1024 * 1024
type FileTypeId = Literal[
    "PE",
    "PDF",
    "ZIP",
    "OLE",
    "ELF",
    "PNG",
    "JPEG",
    "RAR",
    "GZIP",
    "LNK",
    "TEXT",
    "SCRIPT_PS1",
    "SCRIPT_BAT",
    "SCRIPT_VBS",
    "SCRIPT_JS",
    "SCRIPT_PY",
    "SCRIPT_SH",
]
type NonEmpty = Annotated[str, Field(min_length=1, max_length=4096)]


class RuleConfigError(ValueError):
    """Error claro de configuración local; nunca incluye el contenido de un archivo escaneado."""


class StrictSafeLoader(yaml.SafeLoader):
    def compose_node(self, parent, index):
        if self.check_event(yaml.AliasEvent):
            raise RuleConfigError("no se permiten aliases YAML")
        depth = getattr(self, "_depth", 0) + 1
        if depth > 32:
            raise RuleConfigError("anidamiento YAML excesivo")
        self._depth = depth
        try:
            return super().compose_node(parent, index)
        finally:
            self._depth -= 1

    def construct_mapping(self, node, deep=False):
        # Dict: una clave aparece una sola vez. has/insert O(1) promedio; O(k)
        # para validar k claves. Rechazar duplicados evita sobrescribir condiciones.
        result = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in result:
                raise RuleConfigError("clave YAML repetida o no textual")
            result[key] = self.construct_object(value_node, deep=deep)
        return result


class Pattern(ContractModel):
    encoding: Literal["ascii", "utf16", "hex"]
    value: NonEmpty

    def to_bytes(self) -> bytes:
        try:
            value = (
                bytes.fromhex(self.value)
                if self.encoding == "hex"
                else self.value.encode("ascii" if self.encoding == "ascii" else "utf-16-le")
            )
        except (ValueError, UnicodeError) as error:
            raise ValueError("patrón incompatible con su codificación") from error
        if not value or len(value) > 4096:
            raise ValueError("patrón vacío o mayor de 4096 bytes")
        return value

    @model_validator(mode="after")
    def valid_encoding(self) -> "Pattern":
        self.to_bytes()
        return self


def pattern_bytes(pattern: NonEmpty | Pattern) -> bytes:
    return (
        Pattern(encoding="ascii", value=pattern).to_bytes()
        if isinstance(pattern, str)
        else pattern.to_bytes()
    )


class Strings(ContractModel):
    any: Annotated[list[NonEmpty | Pattern], Field(min_length=1, max_length=128)] | None = None
    all: Annotated[list[NonEmpty | Pattern], Field(min_length=1, max_length=128)] | None = None

    @model_validator(mode="after")
    def valid_patterns(self) -> "Strings":
        if self.any is None and self.all is None:
            raise ValueError("strings requiere any o all")
        for pattern in [*(self.any or []), *(self.all or [])]:
            pattern_bytes(pattern)
        return self


class Imports(ContractModel):
    any: Annotated[list[NonEmpty], Field(min_length=1, max_length=128)] | None = None
    all: Annotated[list[NonEmpty], Field(min_length=1, max_length=128)] | None = None

    @model_validator(mode="after")
    def nonempty(self) -> "Imports":
        if self.any is None and self.all is None:
            raise ValueError("peImports requiere any o all")
        return self


class SizeRange(ContractModel):
    min: Annotated[int, Field(ge=0)] | None = None
    max: Annotated[int, Field(ge=0)] | None = None

    @model_validator(mode="after")
    def ordered(self) -> "SizeRange":
        if self.min is None and self.max is None:
            raise ValueError("sizeRange requiere min o max")
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("sizeRange invertido")
        return self


class Conditions(ContractModel):
    fileTypes: Annotated[list[FileTypeId], Field(min_length=1)] | None = None
    extensions: (
        Annotated[list[Annotated[str, Field(pattern=r"^\.[a-zA-Z0-9]+$")]], Field(min_length=1)]
        | None
    ) = None
    sizeRange: SizeRange | None = None
    maxScanBytes: Annotated[int, Field(ge=1, le=MAX_SCAN_BYTES)] = 4 * 1024 * 1024
    strings: Strings | None = None
    peImports: Imports | None = None
    entropyAbove: Annotated[float, Field(ge=0, le=8)] | None = None

    @model_validator(mode="after")
    def has_condition(self) -> "Conditions":
        if all(
            getattr(self, key) is None
            for key in (
                "fileTypes",
                "extensions",
                "sizeRange",
                "strings",
                "peImports",
                "entropyAbove",
            )
        ):
            raise ValueError("la regla requiere al menos una condición")
        return self


class RuleDefinition(ContractModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)
    id: Annotated[str, Field(pattern=r"^R-[A-Z0-9-]+$", max_length=100)]
    name: NonEmpty
    description: NonEmpty
    severity: Literal["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]
    points: Annotated[int, Field(ge=0, le=100)]
    decisive: bool
    conditions: Conditions

    @model_validator(mode="after")
    def points_match_policy(self) -> "RuleDefinition":
        if self.points != SEVERITY_POINTS[self.severity]:
            raise ValueError("points debe coincidir con el peso de severity del plan")
        return self


@dataclass(frozen=True)
class CompiledRule:
    definition: RuleDefinition
    any: tuple[bytes, ...]
    all: tuple[bytes, ...]


class RuleCatalog:
    def __init__(self, directory: Path = DEFAULT_RULES) -> None:
        paths = sorted(directory.glob("*.yaml"))
        if not paths:
            raise RuleConfigError("No hay reglas YAML locales")
        if len(paths) > 256:
            raise RuleConfigError("Máximo 256 reglas locales")
        compiled = []
        # Set de IDs ya usados: invariante sin duplicados; O(1) promedio por inserción.
        ids: set[str] = set()
        digest = hashlib.sha256()
        for path in paths:
            try:
                with path.open("rb") as stream:
                    content = stream.read(MAX_RULE_BYTES + 1)
                if len(content) > MAX_RULE_BYTES:
                    raise RuleConfigError("YAML mayor de 1 MiB")
                document = yaml.load(content.decode("utf-8"), Loader=StrictSafeLoader)
                definition = RuleDefinition.model_validate(document)
                if definition.id in ids:
                    raise RuleConfigError("ID de regla repetido")
                ids.add(definition.id)
                strings = definition.conditions.strings
                compiled.append(
                    CompiledRule(
                        definition,
                        tuple(pattern_bytes(p) for p in (strings.any or [])) if strings else (),
                        tuple(pattern_bytes(p) for p in (strings.all or [])) if strings else (),
                    )
                )
                canonical = json.dumps(
                    definition.model_dump(), sort_keys=True, separators=(",", ":")
                ).encode()
                digest.update(path.name.encode() + b"\0" + canonical + b"\0")
            except ValidationError as error:
                first = error.errors(include_input=False)[0]
                location = ".".join(str(key) for key in first["loc"])
                raise RuleConfigError(
                    f"Regla inválida en {path.name}: {location} ({first['type']})"
                ) from error
            except (OSError, UnicodeError, yaml.YAMLError, RuleConfigError) as error:
                detail = (
                    str(error)
                    if isinstance(error, RuleConfigError)
                    else "YAML ilegible o sintaxis inválida"
                )
                raise RuleConfigError(f"Regla inválida en {path.name}: {detail}") from error
        self.rules = tuple(compiled)
        self.version = "sha256:" + digest.hexdigest()


class RuleStore:
    def __init__(self, directory: Path = DEFAULT_RULES) -> None:
        self.directory = directory
        self._catalog: RuleCatalog | None = None

    def current(self) -> RuleCatalog:
        if self._catalog is None:
            self._catalog = RuleCatalog(self.directory)
        return self._catalog

    def reload(self) -> RuleCatalog:
        # Construir primero y sustituir solo si TODO valida: un error conserva
        # el catálogo previo. Cada análisis retiene su propia referencia estable.
        candidate = RuleCatalog(self.directory)
        self._catalog = candidate
        return candidate


default_rules = RuleStore()


def classify_file_type(prefix: bytes, extension: str | None) -> str | None:
    detected = detect_type(prefix, extension)
    # Dict nombre -> identificador de reglas: claves únicas, consulta O(1) promedio.
    names = {
        "PE ejecutable": "PE",
        "PDF": "PDF",
        "ZIP / OOXML": "ZIP",
        "Office 97 (OLE)": "OLE",
        "ELF": "ELF",
        "PNG": "PNG",
        "JPEG": "JPEG",
        "RAR": "RAR",
        "GZIP": "GZIP",
        "Acceso directo LNK": "LNK",
    }
    if detected and detected.name in names:
        return names[detected.name]
    if is_text(prefix):
        scripts = {
            ".ps1": "SCRIPT_PS1",
            ".psm1": "SCRIPT_PS1",
            ".bat": "SCRIPT_BAT",
            ".cmd": "SCRIPT_BAT",
            ".vbs": "SCRIPT_VBS",
            ".vbe": "SCRIPT_VBS",
            ".js": "SCRIPT_JS",
            ".jse": "SCRIPT_JS",
            ".py": "SCRIPT_PY",
            ".sh": "SCRIPT_SH",
        }
        return scripts.get((extension or "").lower(), "TEXT")
    return None


class RuleConsumer:
    def __init__(self, catalog: RuleCatalog) -> None:
        self.catalog = catalog
        self.offset = 0
        self.ms = 0.0
        self.tails = [b"" for _ in catalog.rules]
        self.found = [set() for _ in catalog.rules]

    def consume(self, chunk: bytes) -> None:
        started = perf_counter()
        try:
            self._consume(chunk)
        finally:
            self.ms += (perf_counter() - started) * 1000

    def _consume(self, chunk: bytes) -> None:
        for index, rule in enumerate(self.catalog.rules):
            remaining = rule.definition.conditions.maxScanBytes - self.offset
            patterns = (*rule.any, *rule.all)
            if remaining <= 0 or not patterns:
                continue
            window = self.tails[index] + chunk[:remaining]
            for pattern in patterns:
                # Set de patrones encontrados, sin duplicados; O(1) promedio para
                # pertenencia. bytes.find busca en un bloque acotado, nunca en todo
                # el archivo. Conservamos len(patrón)-1 para cruzar bloques.
                if pattern not in self.found[index] and window.find(pattern) >= 0:
                    self.found[index].add(pattern)
            overlap = max(len(pattern) for pattern in patterns) - 1
            self.tails[index] = window[-overlap:] if overlap else b""
        self.offset += len(chunk)

    def matches(self) -> frozenset[str]:
        return frozenset(
            rule.definition.id
            for index, rule in enumerate(self.catalog.rules)
            if (not rule.any or any(p in self.found[index] for p in rule.any))
            and all(p in self.found[index] for p in rule.all)
        )


class RuleEngine:
    layer_id: Literal["RULES"] = "RULES"

    def analyze(self, ctx: AnalysisContext) -> list[Evidence]:
        if ctx.rule_catalog is None:
            raise RuleConfigError("Falta el catálogo del recorrido")
        evidence = []
        for rule in ctx.rule_catalog.rules:
            definition = rule.definition
            c = definition.conditions
            if definition.id not in ctx.rule_matches:
                continue
            if c.fileTypes is not None and ctx.file_type not in c.fileTypes:
                continue
            if c.extensions is not None and (ctx.file.extension or "").lower() not in [
                extension.lower() for extension in c.extensions
            ]:
                continue
            if c.sizeRange is not None and (
                (c.sizeRange.min is not None and ctx.size_bytes < c.sizeRange.min)
                or (c.sizeRange.max is not None and ctx.size_bytes > c.sizeRange.max)
            ):
                continue
            if c.entropyAbove is not None and ctx.entropy <= c.entropyAbove:
                continue
            if c.peImports is not None:
                if ctx.pe_imports is None:
                    continue
                # Set de imports normalizados: O(i) construcción y O(1) promedio
                # por consulta. No se interpreta texto de un PE como imports reales.
                imports = {name.casefold() for name in ctx.pe_imports}
                if c.peImports.any and not any(
                    name.casefold() in imports for name in c.peImports.any
                ):
                    continue
                if c.peImports.all and not all(
                    name.casefold() in imports for name in c.peImports.all
                ):
                    continue
            evidence.append(
                Evidence(
                    id=f"ev{len(evidence) + 1}",
                    source="RULES",
                    code=definition.id,
                    title=definition.name,
                    severity=definition.severity,
                    points=definition.points,
                    decisive=definition.decisive,
                    confidence=1,
                    facts={
                        "ruleId": definition.id,
                        "rulesetVersion": ctx.rule_catalog.version,
                        "maxScanBytes": c.maxScanBytes,
                    },
                )
            )
        return evidence
