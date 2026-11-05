"""Solo build: obtiene avisos de fuentes fijadas, no instala ni ejecuta dependencias.

Los textos Rust cubren conservadoramente Cargo.lock completo del sdist verificado;
no se afirma que dependencias de build/otros targets estén en el DLL final.
"""
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tomllib
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

stage, cache, app = (Path(x).resolve() for x in sys.argv[1:4])
notices = stage / "notices"
notices.mkdir(exist_ok=True)
sources = json.loads((Path(__file__).with_name("notice-sources.json")).read_text(encoding="utf-8-sig"))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch(name, url, expected):
    path = cache / name
    if not path.exists():
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
        if sha(data) != expected:
            raise ValueError(f"Hash legal incorrecto: {name}")
        path.write_bytes(data)
    data = path.read_bytes()
    if sha(data) != expected:
        raise ValueError(f"Caché legal alterada: {name}")
    return data


inventory = []


def save(component, name, data, source):
    # Nombres generados, nunca rutas de extracción arbitrarias.
    directory = notices / re.sub(r"[^a-zA-Z0-9_.-]", "_", component)
    directory.mkdir(exist_ok=True)
    target = directory / re.sub(r"[^a-zA-Z0-9_.-]", "_", name)
    if target.exists() and target.read_bytes() != data:
        raise ValueError("Colisión de nombre de licencia")
    target.write_bytes(data)
    inventory.append({"component": component, "path": target.relative_to(notices).as_posix(),
                      "size": len(data), "sha256": sha(data), "source": source})


for source in sources:
    data = fetch(source["name"], source["url"], source["sha256"])
    if source["name"].endswith(".txt"):
        save(source["name"].removesuffix(".txt"), "LICENSE.txt", data, source["url"])
    elif source["name"].endswith(".docx"):
        with zipfile.ZipFile(io.BytesIO(data)) as document:
            root = ET.fromstring(document.read("word/document.xml"))
            ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            microsoft = "\n".join("".join(p.itertext()) for p in root.findall(".//w:p", ns))
        save("Microsoft-VC-2015-2022", "LICENSE.txt", microsoft.encode(), source["url"])
        (notices / "DISTRIBUTION-TERMS.txt").write_text(
            "CyberSOC Defender - distribución Windows por usuario\n\n"
            "Los componentes de terceros se rigen por sus licencias adjuntas. "
            "Al distribuir o utilizar Microsoft Distributable Code deben respetarse "
            "los términos siguientes y los avisos de CPython. No alterar avisos, "
            "no sugerir aval de Microsoft, no redistribuir en plataformas no Microsoft "
            "ni en programas maliciosos, engañosos o ilegales. "
            "La aplicación conserva datos al desinstalar.\n\n" + microsoft, encoding="utf-8")
    elif source["name"].startswith("StdUtils-") and source["name"].endswith(".tar.gz"):
        save("StdUtils-1.14", "corresponding-source.tar.gz", data, source["url"])

full_name = "cpython-3.12.16+20261026-x86_64-pc-windows-msvc-pgo-full.tar.zst"
full = fetch(full_name,
             "https://github.com/astral-sh/python-build-standalone/releases/download/20261026/" + full_name,
             "37b4eb2818fee605fefa75ed156c4f2e1aaeaebaf662f9b30177c842ee16c48f")
tar = str(Path(os.environ["SystemRoot"]) / "System32" / "tar.exe")
entries = subprocess.check_output([tar, "-tf", str(cache / full_name)], text=True).splitlines()
for entry in entries:
    if re.fullmatch(r"python/licenses/[^/]+", entry):
        data = subprocess.check_output([tar, "-xOf", str(cache / full_name), entry])
        save("CPython-full-20261026", entry.rsplit("/", 1)[-1], data, "Astral full sha256:" + sha(full))

nsis_name = "nsis-3.0.4.1.7z"
nsis_url = "https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/" + nsis_name
fetch(nsis_name, nsis_url, "9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa")
save("NSIS-3.0.4.1", "COPYING.txt", subprocess.check_output([tar, "-xOf", str(cache / nsis_name), "COPYING"]), nsis_url)
save("electron-builder-26.18.0", "LICENSE.txt", (app / "node_modules/electron-builder/LICENSE").read_bytes(), "npm lockfile")
save("NSIS-plugins", "ATTRIBUTION.txt", (
    "Plugins del recurso nsis-resources 3.4.1 de electron-builder-binaries.\n"
    "Archivo sha256 593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103.\n"
    "StdUtils Unicode 1.1.4.0 (tag fuente 1.14), Copyright 2004-2018 LoRd_MuldeR. LGPL-2.1-or-later con aclaración del autor. "
    "Texto completo y fuente correspondiente adjuntos; sin modificar el DLL.\n"
    "StdUtils.dll sha256 b72e9013a6204e9f01076dc38dabbf30870d44dfc66962adbf73619d4331601e.\n"
    "UAC, autor Anders, zlib: https://nsis.sourceforge.io/UAC_plug-in . DLL Unicode sha256 "
    "2f7f8fc05dc4fd0d5cda501b47e4433357e887bbfed7292c028d99c73b52dc08.\n"
    "nsProcess, autor Instructor y contribuciones Unicode de brainsucker: https://nsis.sourceforge.io/NsProcess_plugin . "
    "DLL Unicode sha256 30c6c3dd3cc7fcea6e6081ce821adc7b2888542dae30bf00e881c0a105eb4d11. "
    "No publica versión en el PE: se identifica por recurso fijado y hash, no por la versión actual de la wiki.\n"
    "Licencia general de NSIS/plugins zlib y excepción de compresión LZMA: véase NSIS-3.0.4.1/COPYING.txt "
    "y https://nsis.sourceforge.io/Docs/AppendixI.html .\n"
).encode(), "NSIS fuentes oficiales y recurso 3.4.1 fijado")

save("CPython-runtime-3.12.16", "LICENSE.txt", (stage / "runtime/LICENSE.txt").read_bytes(), "runtime SHA256 verificado")
for file in sorted((stage / "runtime/Lib/site-packages").glob("*.dist-info/**/**")):
    if file.is_file() and re.search(r"LICENSE|COPYING|NOTICE", file.name, re.I):
        component = next(part for part in file.parts if part.endswith(".dist-info"))
        save(component, file.relative_to(file.parents[len(file.parts) - file.parts.index(component) - 2]).as_posix(), file.read_bytes(), "wheel uv.lock/RECORD verificado")

lock = json.loads((app / "package-lock.json").read_text())
for relative, package in lock["packages"].items():
    if not relative or package.get("dev"):
        continue
    directory = app / relative
    component = relative.split("node_modules/")[-1] + "-" + package["version"]
    files = [p for p in directory.rglob("*") if p.is_file() and
             "node_modules" not in p.relative_to(directory).parts and re.search(r"^(LICENSE|COPYING|NOTICE)", p.name, re.I)]
    if not files:
        fallback = next((source for source in sources if source.get("component") == component), None)
        if fallback is None:
            raise ValueError("Sin texto legal npm: " + component)
        save(component, "LICENSE.txt", fetch(fallback["name"], fallback["url"], fallback["sha256"]), fallback["url"])
    for file in files:
        save(component, file.relative_to(directory).as_posix(), file.read_bytes(), package.get("resolved", "npm lockfile"))

for name in ("LICENSE", "LICENSES.chromium.html"):
    save("Electron-44.10.2", name, (app / "node_modules/electron/dist" / name).read_bytes(), "Electron ZIP oficial verificado")

sdist_source = next(s for s in sources if s["name"].startswith("pydantic_core-"))
with tarfile.open(fileobj=io.BytesIO(fetch(**{k: sdist_source[k] for k in ("name", "url")}, expected=sdist_source["sha256"])), mode="r:gz") as archive:
    cargo = tomllib.loads(archive.extractfile("pydantic_core-2.46.5/Cargo.lock").read().decode())


def crate_licenses(package):
    name, version = package["name"], package["version"]
    url = f"https://static.crates.io/crates/{name}/{name}-{version}.crate"
    data = fetch(f"{name}-{version}.crate", url, package["checksum"])
    texts = []
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            if member.isfile() and re.search(r"LICENSE|COPYING|NOTICE|COPYRIGHT", member.name, re.I):
                texts.append((member.name.split("/", 1)[-1], archive.extractfile(member).read()))
    if not texts:
        raise ValueError("Crate sin aviso legal: " + name)
    return name + "-" + version, url, texts


# Cada descarga tiene un destino distinto y se valida antes de usarla. No ejecuta Rust.
packages = [p for p in cargo["package"] if p.get("source", "").startswith("registry+") and p["name"] not in ("r-efi", "wit-bindgen-rt")]
# r-efi es solo UEFI y wit-bindgen-rt solo WASI; no compilan en Windows x64.
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    for component, url, texts in pool.map(crate_licenses, packages):
        for name, data in texts:
            save("Rust-source-closure-" + component, name, data, url)

inventory.sort(key=lambda item: item["path"])
(notices / "inventory.json").write_text(json.dumps(inventory, indent=2), encoding="utf-8")
(notices / "THIRD-PARTY-NOTICES.txt").write_text(
    "CyberSOC Defender 0.11.0 - avisos completos adjuntos\n"
    "No se modificó el motor ni los módulos Python; runtime recortado: sin pip/ensurepip, "
    "Tk, herramientas ni tests. _pth aislado y bytecode preparado.\n"
    "Rust-source-closure incluye conservadoramente Cargo.lock del sdist; algunos crates "
    "son solo de build/otros targets. CPython-full incluye textos de otras plataformas, "
    "sin afirmar que sus bibliotecas estén en Windows. r-efi (UEFI) y wit-bindgen-rt (WASI) excluidos.\n\n" +
    "\n".join(item["component"] + " -> " + item["path"] for item in inventory), encoding="utf-8")
print(f"NOTICES_READY {len(inventory)} textos, {len(packages)} crates del cierre fuente")
