param([Parameter(Mandatory=$true)][string]$FixturePath)
$ErrorActionPreference = 'Stop'
$stream = [System.IO.File]::Open($FixturePath, 'Open', 'ReadWrite', 'None')
try {
    [Console]::WriteLine('LOCK_READY')
    [Console]::Out.Flush()
    # El capturador libera el bloqueo cerrando stdin o enviando una línea.
    [Console]::ReadLine() | Out-Null
} finally {
    $stream.Dispose()
}
