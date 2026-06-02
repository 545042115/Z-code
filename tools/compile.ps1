# PowerShell script to compile VS Code extension
$nodePath = "D:\mycode\Z Code\tools\node-v20.14.0-win-x64"

# Detect Node.js
$globalNode = Get-Command "node" -ErrorAction SilentlyContinue
if (-not $globalNode) {
    $bundledNode = Join-Path $nodePath "node.exe"
    if (-not (Test-Path $bundledNode)) {
        Write-Host "Node.js not found!" -ForegroundColor Red
        Write-Host "Please run update.ps1 first to auto-download Node.js" -ForegroundColor Yellow
        exit 1
    }
    $env:PATH = "$nodePath;$env:PATH"
} else {
    Write-Host "Using system Node.js: $($globalNode.Source)" -ForegroundColor Cyan
}

Set-Location "D:\mycode\Z Code\extensions\coding-agent"

# Install TypeScript locally if not exists
if (-not (Test-Path "node_modules\typescript")) {
    & "npm" install typescript --save-dev
}

# Compile
if (Test-Path "node_modules\typescript\bin\tsc") {
    & "npx" tsc -p ./
} else {
    Write-Host "tsc not found after install" -ForegroundColor Red
    exit 1
}

if ($LASTEXITCODE -eq 0) {
    Write-Host "Compilation successful!" -ForegroundColor Green
} else {
    Write-Host "Compilation failed!" -ForegroundColor Red
    exit 1
}
