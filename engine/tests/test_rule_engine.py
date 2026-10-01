from dataclasses import replace
from io import BytesIO

import pytest
import yaml

from cybersoc_engine.analysis.stream import CHUNK_BYTES, consume_stream
from cybersoc_engine.engines.base import AnalysisContext
from cybersoc_engine.engines.rule_engine import (
    RuleCatalog,
    RuleConfigError,
    RuleConsumer,
    RuleEngine,
    RuleStore,
)
from cybersoc_engine.models import FileInfo


def write_rule(root, conditions, *, name="rule.yaml", **changes):
    value = {
        "id": "R-TEST",
        "name": "Regla de prueba",
        "description": "Texto inocuo",
        "severity": "HIGH",
        "points": 25,
        "decisive": False,
        "conditions": conditions,
        **changes,
    }
    path = root / name
    path.write_text(yaml.safe_dump(value), encoding="utf-8")
    return path


def analyze(catalog, content=b"abc", **changes):
    consumer = RuleConsumer(catalog)
    consume_stream(BytesIO(content), (consumer,))
    ctx = AnalysisContext(
        file=FileInfo(name="test.txt", extension=".txt", sizeBytes=len(content), modifiedAt="now"),
        prefix=content[:65536],
        sha256="a" * 64,
        size_bytes=len(content),
        entropy=4.5,
        file_type="TEXT",
        rule_catalog=catalog,
        rule_matches=consumer.matches(),
    )
    return RuleEngine().analyze(replace(ctx, **changes))


@pytest.mark.parametrize(
    "conditions,content,changes,matched",
    [
        ({"fileTypes": ["TEXT"]}, b"abc", {}, True),
        ({"fileTypes": ["PE"]}, b"abc", {}, False),
        ({"extensions": [".TXT"]}, b"abc", {}, True),
        ({"extensions": [".pdf"]}, b"abc", {}, False),
        ({"sizeRange": {"min": 3, "max": 3}}, b"abc", {}, True),
        ({"sizeRange": {"min": 4}}, b"abc", {}, False),
        ({"sizeRange": {"max": 2}}, b"abc", {}, False),
        ({"entropyAbove": 4}, b"abc", {}, True),
        ({"entropyAbove": 4.5}, b"abc", {}, False),
        ({"entropyAbove": 5}, b"abc", {}, False),
        ({"strings": {"any": ["absent", "abc"]}}, b"abc", {}, True),
        ({"strings": {"any": ["missing"]}}, b"abc", {}, False),
        ({"strings": {"all": ["ab", "bc"]}}, b"abc", {}, True),
        ({"strings": {"all": ["ab", "missing"]}}, b"abc", {}, False),
        ({"strings": {"any": ["ab"], "all": ["bc"]}}, b"abc", {}, True),
        ({"strings": {"any": ["missing"], "all": ["bc"]}}, b"abc", {}, False),
        (
            {"strings": {"any": [{"encoding": "utf16", "value": "niño"}]}},
            "niño".encode("utf-16-le"),
            {},
            True,
        ),
        ({"strings": {"any": [{"encoding": "utf16", "value": "niño"}]}}, b"nino", {}, False),
        ({"strings": {"any": [{"encoding": "hex", "value": "61 62 63"}]}}, b"abc", {}, True),
        ({"strings": {"any": [{"encoding": "hex", "value": "61 62 63"}]}}, b"abd", {}, False),
        ({"strings": {"any": [{"encoding": "ascii", "value": "ABC"}]}}, b"ABC", {}, True),
        ({"strings": {"any": [{"encoding": "ascii", "value": "ABC"}]}}, b"abc", {}, False),
        (
            {"peImports": {"any": ["CreateFileW", "Absent"]}},
            b"abc",
            {"pe_imports": ("createfilew",)},
            True,
        ),
        ({"peImports": {"any": ["CreateFileW"]}}, b"CreateFileW", {}, False),
        ({"peImports": {"all": ["One", "Two"]}}, b"abc", {"pe_imports": ("one", "two")}, True),
        ({"peImports": {"all": ["One", "Two"]}}, b"abc", {"pe_imports": ("one",)}, False),
        ({"peImports": {"any": ["One"], "all": ["Two"]}}, b"abc", {"pe_imports": ("two",)}, False),
        (
            {"fileTypes": ["TEXT"], "extensions": [".txt"], "strings": {"all": ["abc"]}},
            b"abc",
            {},
            True,
        ),
        (
            {"fileTypes": ["PE"], "extensions": [".txt"], "strings": {"all": ["abc"]}},
            b"abc",
            {},
            False,
        ),
    ],
)
def test_each_condition_positive_negative_and_combination(
    tmp_path, conditions, content, changes, matched
):
    write_rule(tmp_path, conditions)
    catalog = RuleCatalog(tmp_path)
    findings = analyze(catalog, content, **changes)
    assert bool(findings) is matched
    if matched:
        evidence = findings[0]
        assert evidence.source == "RULES"
        assert evidence.code == "R-TEST"
        assert evidence.points == 25 and not evidence.decisive
        assert evidence.facts["rulesetVersion"] == catalog.version
        assert "abc" not in evidence.facts.values()


@pytest.mark.parametrize(
    "limit,matched", [(CHUNK_BYTES + 2, True), (CHUNK_BYTES + 1, False), (CHUNK_BYTES - 1, False)]
)
def test_pattern_crossing_chunk_and_scan_limit(tmp_path, limit, matched):
    write_rule(tmp_path, {"maxScanBytes": limit, "strings": {"all": ["ABCDE"]}})
    content = b"x" * (CHUNK_BYTES - 3) + b"ABCDE" + b"x" * CHUNK_BYTES
    catalog = RuleCatalog(tmp_path)
    consumer = RuleConsumer(catalog)
    consume_stream(BytesIO(content), (consumer,))
    assert bool(consumer.matches()) is matched
    assert all(len(tail) <= 4 for tail in consumer.tails)


def test_pattern_across_many_short_reads_and_independent_rule_limits(tmp_path):
    write_rule(
        tmp_path, {"maxScanBytes": 5, "strings": {"any": ["ABCDE"]}}, name="b.yaml", id="R-B"
    )
    write_rule(
        tmp_path, {"maxScanBytes": 4, "strings": {"any": ["ABCDE"]}}, name="a.yaml", id="R-A"
    )
    catalog = RuleCatalog(tmp_path)
    consumer = RuleConsumer(catalog)
    for byte in b"ABCDE":
        consumer.consume(bytes([byte]))
    assert consumer.matches() == {"R-B"}


@pytest.mark.parametrize(
    "changes",
    [
        {"conditions": {}},
        {"conditions": {"maxScanBytes": 1}},
        {"conditions": {"maxScanBytes": 0, "extensions": [".txt"]}},
        {"conditions": {"maxScanBytes": 16777217, "extensions": [".txt"]}},
        {"conditions": {"fileTypes": ["GARBAGE"]}},
        {"conditions": {"extensions": ["txt"]}},
        {"conditions": {"sizeRange": {"min": 4, "max": 1}}},
        {"conditions": {"sizeRange": {"min": True}}},
        {"conditions": {"entropyAbove": 9}},
        {"conditions": {"entropyAbove": float("nan")}},
        {"conditions": {"strings": {}}},
        {"conditions": {"strings": {"any": []}}},
        {"conditions": {"strings": {"all": [""]}}},
        {"conditions": {"strings": {"all": ["niño"]}}},
        {"conditions": {"strings": {"any": [{"encoding": "hex", "value": "zz"}]}}},
        {"conditions": {"strings": {"any": [{"encoding": "hex", "value": " "}]}}},
        {"conditions": {"strings": {"any": [{"encoding": "base64", "value": "YWJj"}]}}},
        {"conditions": {"peImports": {}}},
        {"conditions": {"peImports": {"all": []}}},
        {"conditions": {"unknown": "abc"}},
        {"severity": "BOGUS"},
        {"points": 99},
        {"decisive": "false"},
        {"extra": True},
        {"id": "bad"},
    ],
)
def test_invalid_rule_has_filename_and_clear_error(tmp_path, changes):
    changes = dict(changes)
    conditions = changes.pop("conditions", {"extensions": [".txt"]})
    write_rule(tmp_path, conditions, **changes)
    with pytest.raises(RuleConfigError, match="Regla inválida en rule.yaml"):
        RuleCatalog(tmp_path)


@pytest.mark.parametrize(
    "content",
    [
        "id: [unterminated",
        "id: R-A\nid: R-B",
        "!!python/object:builtins.object {}",
        "a: &a [one]\nb: *a",
        "[one, two]",
        "",
        "- " * 40 + "text",
    ],
)
def test_unsafe_duplicate_or_malformed_yaml(tmp_path, content):
    (tmp_path / "bad.yaml").write_text(content, encoding="utf-8")
    with pytest.raises(RuleConfigError, match="Regla inválida en bad.yaml"):
        RuleCatalog(tmp_path)


def test_duplicate_ids_and_missing_catalog(tmp_path):
    with pytest.raises(RuleConfigError, match="No hay reglas"):
        RuleCatalog(tmp_path)
    write_rule(tmp_path, {"extensions": [".txt"]}, name="a.yaml")
    write_rule(tmp_path, {"extensions": [".txt"]}, name="b.yaml")
    with pytest.raises(RuleConfigError, match="ID de regla repetido"):
        RuleCatalog(tmp_path)


def test_reload_atomic_version_and_stable_order(tmp_path):
    path = write_rule(tmp_path, {"strings": {"any": ["abc"]}}, name="b.yaml", id="R-B")
    write_rule(tmp_path, {"strings": {"any": ["abc"]}}, name="a.yaml", id="R-A")
    store = RuleStore(tmp_path)
    first = store.current()
    assert [e.code for e in analyze(first)] == ["R-A", "R-B"]
    path.write_text(path.read_text(encoding="utf-8") + "\n# comentario\n", encoding="utf-8")
    assert store.reload().version == first.version
    path.write_text("bad: [", encoding="utf-8")
    with pytest.raises(RuleConfigError):
        store.reload()
    assert store.current().version == first.version
    assert [e.code for e in analyze(store.current())] == ["R-A", "R-B"]
    write_rule(tmp_path, {"strings": {"any": ["xyz"]}}, name="b.yaml", id="R-B")
    assert store.reload().version != first.version
    assert [e.code for e in analyze(store.current())] == ["R-A"]
    assert [e.code for e in analyze(first)] == ["R-A", "R-B"]
