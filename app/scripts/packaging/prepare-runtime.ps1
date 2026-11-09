# Adapted from the Codex T6.2 draft (base 6d9394d); its worktree is not modified.
# Only the build machine uses uv/network. The client receives a complete runtime.
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

# Remove installation tools from our own runtime, not from the user Python.
# Each absolute target is checked before a recursive deletion.
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
# Explicit list: only inside the extracted/verified runtime, never the user Python.
$remove = @('include','libs','tcl','pythonw.exe','Lib/ensurepip','Lib/venv','Lib/idlelib','Lib/tkinter','Lib/turtledemo','Lib/test',
    'DLLs/_tkinter.pyd','DLLs/tcl86t.dll','DLLs/tk86t.dll','DLLs/zlib1.dll')
$remove += @(Get-ChildItem -LiteralPath (Join-Path $runtimeDirectory 'DLLs') -File -Filter '*_test*.pyd' | ForEach-Object { 'DLLs/' + $_.Name })
foreach ($relative in $remove) {
    $target = [IO.Path]::GetFullPath((Join-Path $runtimeDirectory $relative))
    if (-not $target.StartsWith($runtimeDirectory + [IO.Path]::DirectorySeparatorChar)) { throw 'Limpieza fuera de runtime.' }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
# Do not silently skip a future catalog with another extension.
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $engineDirectory 'data') -Recurse -File) {
    if ($file.Extension -notin @('.json','.yaml','.yml')) { throw "Catálogo no contemplado: $($file.Name)" }
}
& $python -I -B (Join-Path $PSScriptRoot 'verify-wheels.py') $site
if ($LASTEXITCODE -ne 0) { throw 'RECORD de wheels inválido.' }
& $python -I -B (Join-Path $PSScriptRoot 'collect-notices.py') $stageDirectory $cacheDirectory $appDirectory
if ($LASTEXITCODE -ne 0) { throw 'Avisos legales incompletos.' }
# Compiling here, with the same private 3.12, avoids compiling pydantic on the first
# 5 s hello. It only writes build copies; the running engine uses -B.
& $python -I -B -m compileall -q -j 1 --invalidation-mode checked-hash -s $stageDirectory -p resources (Join-Path $runtimeDirectory 'Lib') (Join-Path $bundledEngine 'src')
if ($LASTEXITCODE -ne 0) { throw 'No se pudo compilar el bytecode privado de Python 3.12.' }
Write-Output 'PRIVATE_BYTECODE_READY Python 3.12, hash-checked, solo recursos de build'
& $python -I -B (Join-Path $PSScriptRoot 'runtime-check.py')
if ($LASTEXITCODE -ne 0) { throw 'El Python privado no carga el motor y sus dependencias.' }
$manifest = Get-ChildItem -LiteralPath $stageDirectory -Recurse -File | Where-Object {
    $_.FullName.StartsWith($runtimeDirectory + [IO.Path]::DirectorySeparatorChar) -or
    $_.FullName.StartsWith($bundledEngine + [IO.Path]::DirectorySeparatorChar) -or
    $_.FullName.StartsWith((Join-Path $stageDirectory 'notices') + [IO.Path]::DirectorySeparatorChar)
} | ForEach-Object {
    [ordered]@{path=$_.FullName.Substring($stageDirectory.Length + 1).Replace('\','/');size=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stageDirectory 'resources-manifest.json') -Encoding utf8
Write-Output "PRIVATE_RUNTIME_READY $runtimeDirectory"
