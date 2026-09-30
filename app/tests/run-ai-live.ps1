param([switch]$NoKeyPrompt)
$ErrorActionPreference = 'Stop'
$appDirectory = Split-Path -Parent $PSScriptRoot
$ancestor = Get-Item -LiteralPath $appDirectory
while ($null -ne $ancestor -and -not (Test-Path -LiteralPath (Join-Path $ancestor.FullName 'construccion'))) {
    $ancestor = $ancestor.Parent
}
if ($null -eq $ancestor) { throw 'No se encontró construccion para guardar la evidencia.' }
$evidence = Join-Path $ancestor.FullName 'construccion/sprints/sprint-02-evidencia-ia-v1/evidencias/14-ai-live-test.txt'
$previousKey = $env:CYBERSOC_ANTHROPIC_API_KEY
$previousOptIn = $env:CYBERSOC_RUN_AI_LIVE
Push-Location -LiteralPath $appDirectory
try {
    if (-not $NoKeyPrompt -and [string]::IsNullOrWhiteSpace($env:CYBERSOC_ANTHROPIC_API_KEY)) {
        $maskedKey = Read-Host 'Pega la API key de Claude (entrada oculta)' -AsSecureString
        $env:CYBERSOC_ANTHROPIC_API_KEY = [System.Net.NetworkCredential]::new('', $maskedKey).Password
        Remove-Variable maskedKey
    }
    $env:CYBERSOC_RUN_AI_LIVE = '1'
    $output = & npx.cmd vitest run tests/ai-flow.live.test.ts --maxWorkers=1 --reporter=verbose --no-color 2>&1
    $resultCode = $LASTEXITCODE
    $safeOutput = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    if (-not [string]::IsNullOrEmpty($env:CYBERSOC_ANTHROPIC_API_KEY)) {
        $safeOutput = $safeOutput.Replace($env:CYBERSOC_ANTHROPIC_API_KEY, '[REDACTED]')
    }
    $safeOutput = $safeOutput -replace '\x1b\[[0-9;]*m', ''
    $status = if ([string]::IsNullOrWhiteSpace($env:CYBERSOC_ANTHROPIC_API_KEY)) { 'OMITIDA: falta la clave de desarrollo; no prueba una llamada real.' } else { 'Consultar resultado de Vitest; un skip no acredita una llamada real.' }
    $record = "Fecha UTC: $([DateTime]::UtcNow.ToString('o'))`nComando: npx vitest run tests/ai-flow.live.test.ts --maxWorkers=1 --reporter=verbose --no-color`nEstado: $status`nExit code: $resultCode`n`n$safeOutput`n"
    Set-Content -LiteralPath $evidence -Value $record -Encoding utf8
    Write-Output $record
    Write-Output "Evidencia guardada en: $evidence"
}
finally {
    $env:CYBERSOC_ANTHROPIC_API_KEY = $previousKey
    $env:CYBERSOC_RUN_AI_LIVE = $previousOptIn
    Pop-Location
}
exit $resultCode
