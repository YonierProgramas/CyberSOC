"""Parser aislado: recibe bytes por stdin y devuelve solo metadatos JSON acotados."""

import json
import sys

import pefile

from cybersoc_engine.analysis.stream import ByteHistogram

PE_MAX_BYTES = 8 * 1024 * 1024


def parse_pe(data: bytes) -> dict:
    with pefile.PE(data=data, fast_load=True) as pe:
        if not 1 <= len(pe.sections) <= 96:
            raise ValueError("invalid section count")
        sections = []
        for section in pe.sections:
            start, size = section.PointerToRawData, section.SizeOfRawData
            if size and start + size > len(data):
                raise ValueError("truncated section")
            histogram = ByteHistogram()
            histogram.consume(data[start : start + size])
            sections.append(
                {
                    "name": section.Name.rstrip(b"\0").decode("ascii", "replace"),
                    "entropy": histogram.entropy(),
                    "writable": bool(section.Characteristics & 0x80000000),
                    "executable": bool(section.Characteristics & 0x20000000),
                }
            )
        pe.parse_data_directories(
            directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"]]
        )
        imports = []
        for module in getattr(pe, "DIRECTORY_ENTRY_IMPORT", []):
            for symbol in module.imports:
                if symbol.name:
                    imports.append(symbol.name[:256].decode("ascii", "replace"))
                if len(imports) > 4096:
                    raise ValueError("import limit")
        return {"sections": sections, "imports": imports}


def main() -> None:
    try:
        data = sys.stdin.buffer.read(PE_MAX_BYTES + 1)
        if len(data) > PE_MAX_BYTES:
            raise ValueError("byte limit")
        result = {"data": parse_pe(data)}
    except Exception:
        result = {"error": "PE_MALFORMED"}
    # Canal privado del auxiliar: nunca es el stdout JSON-RPC del servidor.
    sys.stdout.write(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
