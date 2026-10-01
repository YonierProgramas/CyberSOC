"""Prepara únicamente fixtures inofensivos dentro del temporal del capturador."""

import runpy
import shutil
import sys
from pathlib import Path

generator = runpy.run_path(sys.argv[1])
root = Path(sys.argv[2])
with generator["generate_fixtures"](
    include_filetype=True, include_signatures=True
) as generated:
    shutil.copytree(generated, root / "fixtures")

# Dos heurísticas en una muestra: cabecera MZ con relleno, nunca un ejecutable real.
shutil.copyfile(root / "fixtures/pe_disfrazado.pdf", root / "fixtures/factura.pdf.ps1")
for name, count in (("cancelacion", 3000), ("caida", 80)):
    folder = root / name
    folder.mkdir()
    for index in range(count):
        (folder / f"documento-{index:04}.txt").write_text(
            f"Texto inofensivo de demostracion {index}.\n", encoding="utf-8"
        )
(root / "bloqueado.txt").write_text("Texto inofensivo bloqueado.\n", encoding="utf-8")
