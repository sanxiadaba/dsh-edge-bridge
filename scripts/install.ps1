#Requires -Version 5.1
[CmdletBinding()]
param(
  # Copy the files instead of linking them to this repository.
  [switch]$Copy
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$dsh = Join-Path $env:USERPROFILE '.dsh'
$app = Join-Path $dsh 'browser\app'
$skill = Join-Path $dsh 'skills\edge-browser'
$npmBin = Join-Path $env:APPDATA 'npm'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js 22+ is required and must be on PATH.' }

$version = (& $node -p "process.versions.node").Trim()
$major = [int]($version.Split('.')[0])
if ($major -lt 22) { throw "Node.js 22+ is required (found $version)." }

New-Item -ItemType Directory -Force -Path (Split-Path $app), (Split-Path $skill), $npmBin | Out-Null

function Remove-Link([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    # rmdir removes the junction itself; it never touches the target.
    cmd /c rmdir "$Path" | Out-Null
  } else {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Install-Tree([string]$Source, [string]$Dest) {
  Remove-Link $Dest
  if ($Copy) {
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    Copy-Item (Join-Path $Source '*') $Dest -Recurse -Force
  } else {
    New-Item -ItemType Junction -Path $Dest -Target $Source | Out-Null
  }
}

# The runtime and the skill directory become links to this checkout, so an
# installed bridge always runs the code and reads the docs from the repository.
Install-Tree (Join-Path $repo 'app') $app
Install-Tree (Join-Path $repo 'skill') $skill

$cli = Join-Path $app 'cli.mjs'
$cmd = @"
@echo off
"$node" "$cli" %*
exit /b %ERRORLEVEL%
"@
Set-Content -Path (Join-Path $npmBin 'dshedge.cmd') -Value $cmd -Encoding ASCII

$ps1 = @"
& "$node" "$cli" @args
exit `$LASTEXITCODE
"@
Set-Content -Path (Join-Path $npmBin 'dshedge.ps1') -Value $ps1 -Encoding UTF8

$mode = if ($Copy) { 'copied' } else { 'linked to this checkout' }
Write-Host ''
Write-Host "Installed ($mode):"
Write-Host "  runtime : $app"
Write-Host "  skill   : $skill"
Write-Host "  shims   : $npmBin\dshedge.cmd, dshedge.ps1"
Write-Host ''
Write-Host 'Next:'
Write-Host '  dshedge live ensure'
Write-Host '  dshedge live tabs'
Write-Host ''
if (-not $Copy) {
  Write-Host 'The runtime and skill follow this repository. Edits here take effect on the'
  Write-Host 'next bridge start; no reinstall is needed.'
  Write-Host ''
}
Write-Host 'Profiles are created under %USERPROFILE%\.dsh\browser on first use.'
