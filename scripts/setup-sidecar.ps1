# Creates sidecar/.venv and installs the Python sidecar's dependencies (VAD, faster-whisper, embeddings).
# Usage: npm run sidecar:setup   (add -Cpu to skip the CUDA libraries)
param([switch]$Cpu)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root 'sidecar\.venv'
if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
  Write-Host 'Creating virtual environment...'
  py -3 -m venv $venv
}
$py = Join-Path $venv 'Scripts\python.exe'
& $py -m pip install --upgrade pip | Out-Null
$req = Join-Path $root 'sidecar\requirements.txt'
if ($Cpu) {
  Get-Content $req | Where-Object { $_ -notmatch '^nvidia-' } | Set-Content -Encoding utf8 "$env:TEMP\mmd-req-cpu.txt"
  $req = "$env:TEMP\mmd-req-cpu.txt"
}
& $py -m pip install -r $req
Write-Host 'Running sidecar self-tests...'
& $py -m pytest (Join-Path $root 'sidecar\tests') -q
Write-Host 'Done. Models (Whisper, multilingual-e5-small) download on first start into %APPDATA%\mmd-assistant\models.'
