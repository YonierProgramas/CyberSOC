"""Verificación de build; no forma parte del motor ni se distribuye como ejecutable."""
import base64
import csv
import hashlib
import pathlib
import sys

site = pathlib.Path(sys.argv[1]).resolve()
checked = 0
for record in sorted(site.glob("*.dist-info/RECORD")):
    for name, checksum, size in csv.reader(record.open(encoding="utf-8", newline="")):
        if not checksum:
            if not name.endswith(("/RECORD", ".pyc")):
                raise ValueError("Archivo de wheel sin hash")
            continue
        target = (site / name).resolve()
        if not target.is_relative_to(site) or not target.is_file():
            raise ValueError("Ruta de wheel no permitida")
        algorithm, encoded = checksum.split("=", 1)
        if algorithm != "sha256":
            raise ValueError("Algoritmo inesperado")
        data = target.read_bytes()
        actual = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        if actual != encoded or (size and len(data) != int(size)):
            raise ValueError("RECORD no coincide")
        checked += 1
print(f"WHEEL_RECORD_OK {len(list(site.glob('*.dist-info/RECORD')))} wheels, {checked} archivos")
