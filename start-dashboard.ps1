param(
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Set-Location $ProjectDir
$env:PORT = [string]$Port

Write-Host ""
Write-Host "Starting Binance futures dashboard..." -ForegroundColor Cyan
Write-Host "Project: $ProjectDir"
Write-Host "Port:    $Port"
Write-Host ""
Write-Host "Main dashboard:     http://localhost:$Port/" -ForegroundColor Green
Write-Host "Small-cap dashboard: http://localhost:$Port/smallcap.html" -ForegroundColor Green
Write-Host ""
Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow
Write-Host ""

npm start
