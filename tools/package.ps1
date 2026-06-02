# PowerShell script to package VS Code extension
$nodePath = "D:\mycode\Z Code\tools\node-v20.14.0-win-x64"
$env:PATH = "$nodePath;$env:PATH"

Set-Location "D:\mycode\Z Code\extensions\coding-agent"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Coding Agent Extension Packager" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Clean old builds
Write-Host "[1/4] Cleaning old builds..." -ForegroundColor Yellow
if (Test-Path "out") {
    Remove-Item -Recurse -Force "out"
    Write-Host "      ✓ Removed old out/ directory" -ForegroundColor Green
}
if (Test-Path "*.vsix") {
    Remove-Item -Force "*.vsix"
    Write-Host "      ✓ Removed old .vsix files" -ForegroundColor Green
}

# Step 2: Compile TypeScript
Write-Host ""
Write-Host "[2/4] Compiling TypeScript..." -ForegroundColor Yellow
& "$nodePath\node.exe" "node_modules\typescript\bin\tsc" -p ./
if ($LASTEXITCODE -ne 0) {
    Write-Host "      ✗ Compilation failed!" -ForegroundColor Red
    exit 1
}
Write-Host "      ✓ Compilation successful" -ForegroundColor Green

# Step 3: Install vsce if not exists
Write-Host ""
Write-Host "[3/4] Checking vsce..." -ForegroundColor Yellow
if (-not (Test-Path "$nodePath\vsce.cmd")) {
    Write-Host "      → Installing vsce..." -ForegroundColor Yellow
    & "$nodePath\npm.cmd" install -g @vscode/vsce
    if ($LASTEXITCODE -ne 0) {
        Write-Host "      ✗ Failed to install vsce" -ForegroundColor Red
        exit 1
    }
}
Write-Host "      ✓ vsce ready" -ForegroundColor Green

# Step 4: Package extension
Write-Host ""
Write-Host "[4/4] Packaging extension..." -ForegroundColor Yellow
& "$nodePath\vsce.cmd" package --no-dependencies
if ($LASTEXITCODE -ne 0) {
    Write-Host "      ✗ Packaging failed!" -ForegroundColor Red
    exit 1
}

# Find the generated .vsix file
$vsixFile = Get-ChildItem -Filter "*.vsix" | Select-Object -First 1
if ($vsixFile) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  ✓ Package created successfully!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "File: $($vsixFile.FullName)" -ForegroundColor Cyan
    Write-Host "Size: $([math]::Round($vsixFile.Length / 1KB, 2)) KB" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Installation:" -ForegroundColor Yellow
    Write-Host "  1. Open VS Code" -ForegroundColor White
    Write-Host "  2. Go to Extensions (Ctrl+Shift+X)" -ForegroundColor White
    Write-Host "  3. Click '...' → 'Install from VSIX'" -ForegroundColor White
    Write-Host "  4. Select: $($vsixFile.Name)" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host "      ✗ Package file not found" -ForegroundColor Red
    exit 1
}
