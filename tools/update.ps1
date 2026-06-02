# PowerShell script to update VS Code extension
# One-click update .vsix file

$nodePath = "D:\mycode\Z Code\tools\node-v20.14.0-win-x64"
$env:PATH = "$nodePath;$env:PATH"

$extensionPath = "D:\mycode\Z Code\extensions\coding-agent"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Coding Agent Extension Updater" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Clean old builds
Write-Host "[1/5] Cleaning old builds..." -ForegroundColor Yellow

$outPath = Join-Path $extensionPath "out"
if (Test-Path $outPath) {
    Remove-Item -Recurse -Force $outPath
    Write-Host "      Deleted out/ directory" -ForegroundColor Green
}

# Delete old .vsix files
$oldVsix = Get-ChildItem -Path $extensionPath -Filter "*.vsix"
if ($oldVsix) {
    $oldVsix | ForEach-Object { 
        Remove-Item $_.FullName
        Write-Host "      Deleted old file: $($_.Name)" -ForegroundColor Green
    }
}

# Step 2: Install dependencies
Write-Host ""
Write-Host "[2/5] Checking dependencies..." -ForegroundColor Yellow
$nodeModulesPath = Join-Path $extensionPath "node_modules"
if (-not (Test-Path $nodeModulesPath)) {
    Write-Host "      Installing dependencies..." -ForegroundColor Yellow
    Push-Location $extensionPath
    & "$nodePath\npm.cmd" install
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        Write-Host "      Dependencies installation failed" -ForegroundColor Red
        exit 1
    }
}
Write-Host "      Dependencies ready" -ForegroundColor Green

# Step 3: Compile TypeScript
Write-Host ""
Write-Host "[3/5] Compiling TypeScript..." -ForegroundColor Yellow
$packageJsonPath = Join-Path $extensionPath "package.json"
$tsConfigPath = Join-Path $extensionPath "tsconfig.json"
$tscPath = Join-Path $extensionPath "node_modules\typescript\bin\tsc"

& "$nodePath\node.exe" "$tscPath" -p "$tsConfigPath"
if ($LASTEXITCODE -ne 0) {
    Write-Host "      Compilation failed" -ForegroundColor Red
    exit 1
}
Write-Host "      Compilation successful" -ForegroundColor Green

# Step 4: Update version (optional)
Write-Host ""
Write-Host "[4/5] Checking version..." -ForegroundColor Yellow
$packageJson = Get-Content "$packageJsonPath" | ConvertFrom-Json
$currentVersion = $packageJson.version
Write-Host "      Current version: $currentVersion" -ForegroundColor Cyan

$updateVersion = Read-Host "Update version? (y/n, default: n)"
if ($updateVersion -eq "y" -or $updateVersion -eq "Y") {
    $versionParts = $currentVersion.Split('.')
    $newPatch = [int]$versionParts[2] + 1
    $newVersion = "$($versionParts[0]).$($versionParts[1]).$newPatch"
    
    $customVersion = Read-Host "Enter new version (default: $newVersion)"
    if ($customVersion) {
        $newVersion = $customVersion
    }
    
    $packageJson.version = $newVersion
    $packageJson | ConvertTo-Json -Depth 10 | Set-Content "$packageJsonPath"
    Write-Host "      Version updated: $newVersion" -ForegroundColor Green
}

# Step 5: Package
Write-Host ""
Write-Host "[5/5] Packaging extension..." -ForegroundColor Yellow

Push-Location $extensionPath
Write-Host "      Installing vsce packaging tool..." -ForegroundColor Yellow
& "$nodePath\npm.cmd" install --save-dev @vscode/vsce
if ($LASTEXITCODE -eq 0) {
    & "$nodePath\npx.cmd" vsce package --no-dependencies
}
Pop-Location

if ($LASTEXITCODE -ne 0) {
    Write-Host "      Packaging failed" -ForegroundColor Red
    exit 1
}

# Show results
$vsixFile = Get-ChildItem -Path $extensionPath -Filter "*.vsix" | Select-Object -First 1
if ($vsixFile) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Update Successful!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "File: $($vsixFile.FullName)" -ForegroundColor Cyan
    Write-Host "Size: $([math]::Round($vsixFile.Length / 1KB, 2)) KB" -ForegroundColor Cyan
    Write-Host "Version: $($packageJson.version)" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Installation:" -ForegroundColor Yellow
    Write-Host "  1. Open VS Code" -ForegroundColor White
    Write-Host "  2. Ctrl+Shift+X to open Extensions" -ForegroundColor White
    Write-Host "  3. Uninstall old Coding Agent if exists" -ForegroundColor White
    Write-Host "  4. Click ... -> Install from VSIX" -ForegroundColor White
    Write-Host "  5. Select: $($vsixFile.Name)" -ForegroundColor White
    Write-Host ""
    
    # Ask for auto install
    $autoInstall = Read-Host "Auto install in VS Code? (y/n, default: n)"
    if ($autoInstall -eq "y" -or $autoInstall -eq "Y") {
        $codeCmd = Get-Command "code" -ErrorAction SilentlyContinue
        if ($codeCmd) {
            & code --install-extension $vsixFile.FullName --force
            Write-Host "      Installed to VS Code" -ForegroundColor Green
        } else {
            Write-Host "      code command not found, please install manually" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "      .vsix file not found" -ForegroundColor Red
}

Write-Host ""
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
