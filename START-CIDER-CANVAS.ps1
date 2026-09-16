$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
npm install --include=dev --no-audit --no-fund
Write-Host "Starting Cider plugin dev server on http://127.0.0.1:3058" -ForegroundColor Green
npm run dev
