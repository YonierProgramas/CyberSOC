param([Parameter(Mandatory=$true)][string]$FixturePath)
$ErrorActionPreference = 'Stop'
$stream = [System.IO.File]::Open($FixturePath, 'Open', 'ReadWrite', 'None')
try {
    [Console]::WriteLine('LOCK_READY')
    [Console]::Out.Flush()
    # The capturer releases the lock by closing stdin or sending a line.
    [Console]::ReadLine() | Out-Null
} finally {
    $stream.Dispose()
}
