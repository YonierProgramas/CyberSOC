param([Parameter(Mandatory=$true)][string]$SessionFile)
$ErrorActionPreference='Stop'
$session = Get-Content -Raw -Encoding UTF8 -LiteralPath $SessionFile | ConvertFrom-Json
if ($session.profile -notlike '*cybersoc-s11-*') { throw 'No es un perfil descartable.' }
$all = @(Get-CimInstance Win32_Process)
$main = @($all | Where-Object { $_.ProcessId -eq $session.pid -and $_.ExecutablePath -eq $session.exe -and $_.CommandLine.Contains($session.profile) })
if ($main.Count -eq 0) {
    if (@($all | Where-Object ProcessId -eq $session.pid).Count) { throw 'PID vivo con identidad distinta; no se detiene.' }
    Write-Output 'Proceso de prueba ya cerrado'; exit 0
}
if ($main.Count -ne 1) { throw 'Identidad de proceso no inequívoca.' }
# Only the descendant tree of that checked process. Test termination, not a UI close.
$owned = @([int]$session.pid)
do {
    $next = @($all | Where-Object { $_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned })
    $owned += @($next | ForEach-Object { [int]$_.ProcessId })
} while ($next.Count -gt 0)
foreach ($processId in $owned) { Stop-Process -Id $processId -ErrorAction SilentlyContinue }
Write-Output ('FORCED_TEST_STOP perfil conservado, PIDs: ' + ($owned -join ','))
