# 開発用リポジトリ（DesktopMMD-dev）のコミット済みの内容を、公開用リポジトリ（DesktopMMD-public）へ反映する。
# 公開用には履歴を引き継がない。差分を1コミットとして積む。push は手動（-Push を付けたときだけ行う）。
#
#   .\scripts\sync-public.ps1 -Message "v0.2.3: ..."          # 反映してコミットまで
#   .\scripts\sync-public.ps1 -Message "v0.2.3: ..." -Push    # push まで
param(
  [Parameter(Mandatory = $true)][string]$Message,
  [string]$PublicDir = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) 'DesktopMMD-public'),
  [switch]$Push
)
$ErrorActionPreference = 'Stop'
$dev = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path (Join-Path $PublicDir '.git'))) { throw "公開用リポジトリが見つかりません: $PublicDir" }
if (git -C $dev status --porcelain) { throw '開発用リポジトリに未コミットの変更があります。先にコミットしてください（反映されるのはコミット済みの内容だけです）。' }
if (git -C $PublicDir status --porcelain) { throw '公開用リポジトリに未コミットの変更があります。' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("mmd-sync-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  git -C $dev archive HEAD --format=tar -o "$tmp.tar"
  tar -xf "$tmp.tar" -C $tmp
  Remove-Item "$tmp.tar"

  # 公開用の追跡ファイルを消してから、開発用の内容を置く（削除・リネームも反映される）
  foreach ($f in (git -C $PublicDir ls-files)) { Remove-Item -LiteralPath (Join-Path $PublicDir $f) -Force -ErrorAction SilentlyContinue }
  Copy-Item -Path (Join-Path $tmp '*') -Destination $PublicDir -Recurse -Force
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

git -C $PublicDir add -A
if (-not (git -C $PublicDir status --porcelain)) { Write-Host '差分はありません。'; return }

# 秘密情報・個人情報のチェック（見つかったらコミットしない）
$gitleaks = Get-Command gitleaks -ErrorAction SilentlyContinue
if ($gitleaks) {
  $ErrorActionPreference = 'Continue'   # gitleaks はログを stderr に出すため、PowerShell 5.1 ではエラー扱いにしない
  & gitleaks git --staged --redact --no-banner $PublicDir 2>&1 | Out-Host
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0) { git -C $PublicDir reset -q; throw 'gitleaks が秘密情報を検出しました。コミットを中止しました。' }
} else {
  Write-Warning 'gitleaks が見つからないため、秘密情報のスキャンを省略しました。'
}
$denyFile = Join-Path $dev '.sync-deny.txt'   # 公開したくない文字列（正規表現、1行1つ）。git管理外
if (Test-Path $denyFile) {
  $pat = ((Get-Content $denyFile -Encoding UTF8) | Where-Object { $_.Trim() }) -join '|'
  $ng = if ($pat) { git -C $PublicDir grep -nIiE $pat } else { $null }
  if ($ng) { git -C $PublicDir reset -q; throw "公開したくない文字列が残っています:`n$ng" }
} else {
  Write-Warning '.sync-deny.txt が無いため、個人情報の文字列チェックを省略しました。'
}

git -C $PublicDir commit -q -m "$Message`n`nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git -C $PublicDir log --oneline -1
git -C $PublicDir diff --stat HEAD~1 | Select-Object -Last 1

if ($Push) { git -C $PublicDir push origin main } else { Write-Host "push する場合: git -C `"$PublicDir`" push origin main" }
