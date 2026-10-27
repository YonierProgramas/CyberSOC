# Adaptación del borrador Codex T6.2 (base 6d9394d), no se modifica su worktree.
# Solo el equipo de build usa uv/red. El cliente recibe un runtime completo.
param([switch]$Rebuild)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not [Environment]::Is64BitOperatingSystem -or $env:OS -ne 'Windows_NT') {
    throw 'Este paquete requiere Windows x64.'
}
$appDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$engineDirectory = [IO.Path]::GetFullPath((Join-Path $appDirectory '../engine'))
$outputDirectory = Join-Path $appDirectory 'out'
$stageDirectory = Join-Path $outputDirectory 'packaging'
$cacheDirectory = Join-Path $outputDirectory 'packaging-cache'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-source.json') -Raw | ConvertFrom-Json
foreach ($directory in @($outputDirectory, $stageDirectory, $cacheDirectory)) {
    if ((Test-Path -LiteralPath $directory) -and
        ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "No se permite un enlace en el directorio de build: $directory"
    }
}
if (Test-Path -LiteralPath $stageDirectory) {
    if (-not $Rebuild) { throw 'Staging existente. Para regenerar solo recursos propios usa -Rebuild.' }
    $resolvedStage = (Resolve-Path -LiteralPath $stageDirectory).Path
    $expectedStage = [IO.Path]::GetFullPath((Join-Path $appDirectory 'out/packaging'))
    if ($resolvedStage -ne $expectedStage -or -not $resolvedStage.StartsWith($outputDirectory + [IO.Path]::DirectorySeparatorChar) -or
        -not (Test-Path -LiteralPath (Join-Path $stageDirectory '.cybersoc-build-owned'))) {
        throw 'No se elimina un staging ajeno o fuera del out de esta app.'
    }
    if (Get-ChildItem -LiteralPath $stageDirectory -Recurse -Force |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
        throw 'No se limpia un staging con enlaces.'
    }
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}
New-Item -ItemType Directory -Path $stageDirectory,$cacheDirectory -Force | Out-Null
Set-Content -LiteralPath (Join-Path $stageDirectory '.cybersoc-build-owned') -Value 'T7.F'
$archive = Join-Path $cacheDirectory $source.archiveName
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri $source.url -OutFile $archive -TimeoutSec 180
}
$actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $source.sha256) { throw 'SHA-256 del runtime incorrecto: no se extrae ni ejecuta.' }
Write-Output "PYTHON_ARCHIVE_SHA256_OK $actualHash"
$entries = & tar.exe -tf $archive
if ($LASTEXITCODE -ne 0) { throw 'No se pudo inspeccionar el archivo de Python.' }
foreach ($entry in $entries) {
    if (-not $entry.StartsWith('python/') -or $entry -match '(^|/)\.\.(/|$)|\\|:') { throw 'Ruta de archivo no permitida.' }
}
$runtimeDirectory = Join-Path $stageDirectory 'runtime'
New-Item -ItemType Directory -Path $runtimeDirectory | Out-Null
& tar.exe -xf $archive -C $runtimeDirectory --strip-components=1
if ($LASTEXITCODE -ne 0) { throw 'Extracción de Python falló.' }
if (Get-ChildItem -LiteralPath $runtimeDirectory -Recurse -Force |
    Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Runtime con enlaces no permitido.' }

# Retirar herramientas de instalación del runtime propio, no de Python del usuario.
# Se comprueba cada destino absoluto antes de una eliminación recursiva.
$licenseDirectory = Join-Path $runtimeDirectory 'licenses/build-tools'
New-Item -ItemType Directory -Force -Path $licenseDirectory | Out-Null
$site = Join-Path $runtimeDirectory 'Lib/site-packages'
if (Test-Path -LiteralPath $site) {
    foreach ($item in Get-ChildItem -LiteralPath $site -Force) {
        if ($item.Name -notmatch '^(pip|setuptools|wheel)(-|$)|^pkg_resources$|^_distutils_hack$|^distutils-precedence\.pth$') { continue }
        $target = [IO.Path]::GetFullPath($item.FullName)
        if (-not $target.StartsWith($runtimeDirectory + [IO.Path]::DirectorySeparatorChar)) { throw 'Destino de limpieza fuera del runtime.' }
        if ($item.PSIsContainer) {
            foreach ($license in Get-ChildItem -LiteralPath $target -Recurse -File | Where-Object { $_.Name -match 'LICENSE|COPYING|NOTICE' }) {
                Copy-Item -LiteralPath $license.FullName -Destination (Join-Path $licenseDirectory ($item.Name + '-' + $license.Name))
            }
            Remove-Item -LiteralPath $target -Recurse -Force
        } else { Remove-Item -LiteralPath $target -Force }
    }
}
$scriptsDirectory = Join-Path $runtimeDirectory 'Scripts'
if (Test-Path -LiteralPath $scriptsDirectory) {
    $resolvedScripts = (Resolve-Path -LiteralPath $scriptsDirectory).Path
    if ($resolvedScripts -ne (Join-Path $runtimeDirectory 'Scripts')) { throw 'Scripts fuera del runtime.' }
    Remove-Item -LiteralPath $resolvedScripts -Recurse -Force
}

$requirements = Join-Path $stageDirectory 'requirements.txt'
& uv export --project $engineDirectory --locked --no-dev --no-emit-project --format requirements.txt --output-file $requirements
if ($LASTEXITCODE -ne 0) { throw 'uv export --locked falló.' }
& uv pip install --target $site --python-version 3.12 --python-platform x86_64-pc-windows-msvc --only-binary :all: --require-hashes --no-deps -r $requirements
if ($LASTEXITCODE -ne 0) { throw 'No se pudieron instalar los wheels bloqueados.' }
@'
.
DLLs
Lib
Lib/site-packages
../engine/src
'@ | Set-Content -LiteralPath (Join-Path $runtimeDirectory 'python312._pth') -Encoding ascii

$bundledEngine = Join-Path $stageDirectory 'engine'
foreach ($folder in @('src','data')) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $engineDirectory $folder) -Recurse -File) {
        if ($file.Extension -notin @('.py','.json','.yaml','.yml')) { continue }
        $relative = $file.FullName.Substring($engineDirectory.Length + 1)
        $target = Join-Path $bundledEngine $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target
    }
}
Copy-Item -LiteralPath (Join-Path $engineDirectory 'uv.lock') -Destination (Join-Path $bundledEngine 'uv.lock')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime-source.json') -Destination (Join-Path $runtimeDirectory 'runtime-source.json')
$python = Join-Path $runtimeDirectory 'python.exe'
# Compilar aquí, con el mismo 3.12 privado, evita compilar pydantic al primer
# saludo de 5 s. Solo escribe copias de build; el motor en ejecución usa -B.
& $python -I -B -m compileall -q -j 1 --invalidation-mode checked-hash -s $stageDirectory -p resources (Join-Path $runtimeDirectory 'Lib') (Join-Path $bundledEngine 'src')
if ($LASTEXITCODE -ne 0) { throw 'No se pudo compilar el bytecode privado de Python 3.12.' }
Write-Output 'PRIVATE_BYTECODE_READY Python 3.12, hash-checked, solo recursos de build'
& $python -I -B -c 'import sys,json,pydantic,yaml,pefile,importlib.util;from cybersoc_engine.engines.signature_engine import default_catalog;assert sys.version_info[:3]==(3,12,16);assert importlib.util.find_spec("pip") is None;print(json.dumps({"python":sys.version,"executable":sys.executable,"signatures":default_catalog().count,"sys_path":sys.path}))'
if ($LASTEXITCODE -ne 0) { throw 'El Python privado no carga el motor y sus dependencias.' }
$manifest = Get-ChildItem -LiteralPath $stageDirectory -Recurse -File | Where-Object {
    $_.FullName.StartsWith($runtimeDirectory + [IO.Path]::DirectorySeparatorChar) -or
    $_.FullName.StartsWith($bundledEngine + [IO.Path]::DirectorySeparatorChar)
} | ForEach-Object {
    [ordered]@{path=$_.FullName.Substring($stageDirectory.Length + 1).Replace('\','/');size=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stageDirectory 'resources-manifest.json') -Encoding utf8
Write-Output "PRIVATE_RUNTIME_READY $runtimeDirectory"
