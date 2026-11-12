#Requires -Version 5.1
[CmdletBinding()]
param(
  [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'
$dsh = Join-Path $env:USERPROFILE '.dsh'
$app = Join-Path $dsh 'browser\app'
$skill = Join-Path $dsh 'skills\edge-browser'
$npmBin = Join-Path $env:APPDATA 'npm'

Write-Host 'Stopping bridge if it is running...'
$statePath = Join-Path $dsh 'browser\state.json'
if (Test-Path $statePath) {
  try {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    $headers = @{ 'content-type' = 'application/json'; 'x-dsh-token' = $state.token }
    Invoke-RestMethod -Uri "http://127.0.0.1:$($state.port)/shutdown" -Method Post -Headers $headers -Body '{"closeEdge":false}' -TimeoutSec 3 | Out-Null
  } catch { }
}

Remove-Item (Join-Path $npmBin 'dshedge.cmd') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $npmBin 'dshedge.ps1') -Force -ErrorAction SilentlyContinue
Remove-Item $app -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $skill -Recurse -Force -ErrorAction SilentlyContinue

if ($PurgeData) {
  Remove-Item (Join-Path $dsh 'browser') -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Removed runtime, skill, shims and browser profiles.'
} else {
  Write-Host 'Removed runtime, skill and shims. Browser profiles were kept.'
  Write-Host 'Re-run with -PurgeData to delete %USERPROFILE%\.dsh\browser as well.'
}
