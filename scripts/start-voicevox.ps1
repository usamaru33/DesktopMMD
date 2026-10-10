# Starts the locally installed VOICEVOX engine on 127.0.0.1:50021 if it is not already running.
$ErrorActionPreference = 'Stop'
try {
  $v = Invoke-RestMethod -Uri 'http://127.0.0.1:50021/version' -TimeoutSec 2
  Write-Host "VOICEVOX $v is already running"
  exit 0
} catch {}
$candidates = @(
  "$env:LOCALAPPDATA\Programs\VOICEVOX\vv-engine\run.exe",
  "$env:ProgramFiles\VOICEVOX\vv-engine\run.exe"
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { Write-Error 'VOICEVOX engine (run.exe) not found. Install VOICEVOX first.'; exit 1 }
Start-Process -FilePath $exe -ArgumentList '--host', '127.0.0.1', '--port', '50021' -WindowStyle Hidden
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try { $v = Invoke-RestMethod -Uri 'http://127.0.0.1:50021/version' -TimeoutSec 1; Write-Host "VOICEVOX $v started"; exit 0 } catch {}
}
Write-Error 'VOICEVOX did not respond within 30 s'
