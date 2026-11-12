#Requires -Version 5.1
[CmdletBinding()]
param()

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

New-Item -ItemType Directory -Force -Path $app, $skill, $npmBin | Out-Null

# Back up an existing installation, but never touch browser profiles.
if (Test-Path (Join-Path $app 'bridge.mjs')) {
  $backup = Join-Path $dsh ("browser\backup\install-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  Copy-Item (Join-Path $app '*') $backup -Recurse -Force
}

Copy-Item (Join-Path $repo 'app\*') $app -Recurse -Force
Copy-Item (Join-Path $repo 'skill\*') $skill -Recurse -Force

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

Write-Host ''
Write-Host 'Installed:'
Write-Host "  runtime : $app"
Write-Host "  skill   : $skill"
Write-Host "  shims   : $npmBin\dshedge.cmd, dshedge.ps1"
Write-Host ''
Write-Host 'Next:'
Write-Host '  dshedge live ensure'
Write-Host '  dshedge live tabs'
Write-Host ''
Write-Host 'Profiles are created under %USERPROFILE%\.dsh\browser on first use.'
