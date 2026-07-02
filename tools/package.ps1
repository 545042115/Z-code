# PowerShell script to compile and package the VS Code extension.
$repoRoot = "D:\mycode\Ziner"
$nodePath = Join-Path $repoRoot "tools\node-v20.14.0-win-x64"
$extensionPath = Join-Path $repoRoot "extensions\coding-agent"
$env:PATH = "$nodePath;$env:PATH"

Set-Location $extensionPath

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Coding Agent Extension Packager" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Clean old builds
Write-Host "[1/4] Cleaning old builds..." -ForegroundColor Yellow
if (Test-Path "out") {
    Remove-Item -Recurse -Force "out"
    Write-Host "      Removed old out/ directory" -ForegroundColor Green
}
Get-ChildItem -Filter "*.vsix" | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Force
    Write-Host "      Removed old package: $($_.Name)" -ForegroundColor Green
}

# Step 2: Compile TypeScript
Write-Host ""
Write-Host "[2/4] Compiling TypeScript..." -ForegroundColor Yellow
& (Join-Path $nodePath "node.exe") "node_modules\typescript\bin\tsc" -p ./
if ($LASTEXITCODE -ne 0) {
    Write-Host "      Compilation failed!" -ForegroundColor Red
    exit 1
}
Write-Host "      Compilation successful" -ForegroundColor Green

# Step 3: Find or install vsce
Write-Host ""
Write-Host "[3/4] Checking vsce..." -ForegroundColor Yellow
$vsceCmd = Join-Path $extensionPath "node_modules\.bin\vsce.cmd"
if (-not (Test-Path $vsceCmd)) {
    $bundledVsce = Join-Path $nodePath "vsce.cmd"
    if (Test-Path $bundledVsce) {
        $vsceCmd = $bundledVsce
    }
}
if (-not (Test-Path $vsceCmd)) {
    Write-Host "      Installing @vscode/vsce locally..." -ForegroundColor Yellow
    & (Join-Path $nodePath "npm.cmd") install --save-dev @vscode/vsce --legacy-peer-deps
    if ($LASTEXITCODE -ne 0) {
        Write-Host "      Failed to install vsce" -ForegroundColor Red
        exit 1
    }
    $vsceCmd = Join-Path $extensionPath "node_modules\.bin\vsce.cmd"
}
Write-Host "      vsce ready: $vsceCmd" -ForegroundColor Green

# Step 4: Package extension
Write-Host ""
Write-Host "[4/4] Packaging extension..." -ForegroundColor Yellow
& $vsceCmd package --no-dependencies
if ($LASTEXITCODE -ne 0) {
    Write-Host "      Packaging failed!" -ForegroundColor Red
    exit 1
}

$vsixFile = Get-ChildItem -Filter "*.vsix" | Select-Object -First 1
if ($vsixFile) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Package created successfully!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "File: $($vsixFile.FullName)" -ForegroundColor Cyan
    Write-Host "Size: $([math]::Round($vsixFile.Length / 1KB, 2)) KB" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Install it from VS Code: Extensions > ... > Install from VSIX" -ForegroundColor Yellow
} else {
    Write-Host "      Package file not found" -ForegroundColor Red
    exit 1
}
