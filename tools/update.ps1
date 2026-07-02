# PowerShell script to update VS Code extension
# One-click update .vsix file

$nodePath = "D:\mycode\Ziner\tools\node-v20.14.0-win-x64"

# Function to detect or setup Node.js
function Setup-NodeJS {
    # Check if node is on PATH
    $globalNode = Get-Command "node" -ErrorAction SilentlyContinue
    if ($globalNode) {
        $nodeExe = "node"
        $npmExe = if (Get-Command "npm" -ErrorAction SilentlyContinue) { "npm" } else { "npm.cmd" }
        Write-Host "      Using system Node.js: $($globalNode.Source)" -ForegroundColor Cyan
        return $true
    }

    # Check bundled node path
    $bundledNode = Join-Path $nodePath "node.exe"
    $bundledNpm = Join-Path $nodePath "npm.cmd"
    if (Test-Path $bundledNode) {
        $script:nodePathResolved = $nodePath
        $env:PATH = "$nodePath;$env:PATH"
        $script:nodePathSet = $true
        Write-Host "      Using bundled Node.js: $nodePath" -ForegroundColor Cyan
        return $true
    }

    # Auto-download Node.js
    Write-Host "      Node.js not found, downloading..." -ForegroundColor Yellow
    $nodeUrl = "https://nodejs.org/dist/v20.14.0/node-v20.14.0-win-x64.zip"
    $zipPath = Join-Path $nodePath "node.zip"
    
    # Create directory
    New-Item -ItemType Directory -Force -Path $nodePath | Out-Null
    
    try {
        # Download using .NET WebClient
        $webClient = New-Object System.Net.WebClient
        Write-Host "      Downloading Node.js v20.14.0..." -ForegroundColor Yellow
        $webClient.DownloadFile($nodeUrl, $zipPath)
        Write-Host "      Download complete, extracting..." -ForegroundColor Yellow
        
        # Extract zip
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $nodePath)
        
        # Move files from subfolder to target
        $subFolder = Get-ChildItem -Path $nodePath -Directory | Where-Object { $_.Name -like "node-v20*" } | Select-Object -First 1
        if ($subFolder) {
            Get-ChildItem -Path $subFolder.FullName | Move-Item -Destination $nodePath -Force
            Remove-Item -Recurse -Force $subFolder.FullName
        }
        
        Remove-Item $zipPath -Force
        
        if (Test-Path $bundledNode) {
            $env:PATH = "$nodePath;$env:PATH"
            Write-Host "      Node.js downloaded and ready" -ForegroundColor Green
            return $true
        } else {
            Write-Host "      Node.js download/extraction failed" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host "      Download failed: $_" -ForegroundColor Red
        Write-Host "      Please download Node.js manually from: https://nodejs.org/" -ForegroundColor Yellow
        Write-Host "      Extract to: $nodePath" -ForegroundColor Yellow
        return $false
    }
}

# Function to ensure dependencies are installed
function Ensure-Dependencies {
    param([string]$extPath)
    
    $nodeModulesPath = Join-Path $extPath "node_modules"
    $packageLockPath = Join-Path $extPath "package-lock.json"
    
    if (-not (Test-Path $nodeModulesPath)) {
        Write-Host "      Installing project dependencies..." -ForegroundColor Yellow
        Push-Location $extPath
        & "$nodePath\npm.cmd" install --legacy-peer-deps
        Pop-Location
        if ($LASTEXITCODE -ne 0) {
            Write-Host "      npm install failed, retrying with --force..." -ForegroundColor Yellow
            Push-Location $extPath
            & "$nodePath\npm.cmd" install --force
            Pop-Location
        }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "      Dependency installation failed" -ForegroundColor Red
            return $false
        }
        Write-Host "      Dependencies installed" -ForegroundColor Green
    } else {
        Write-Host "      Dependencies already installed" -ForegroundColor Green
    }
    return $true
}

function Ensure-Vsce {
    param([string]$extPath)
    
    $vscePath = Join-Path $extPath "node_modules\@vscode\vsce\out\vsce"
    if (-not (Test-Path $vscePath)) {
        Write-Host "      Installing @vscode/vsce..." -ForegroundColor Yellow
        Push-Location $extPath
        & "$nodePath\npm.cmd" install --save-dev @vscode/vsce --legacy-peer-deps
        Pop-Location
        if ($LASTEXITCODE -ne 0) {
            Write-Host "      vsce installation failed, will try npx fallback" -ForegroundColor Yellow
        }
    }
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Coding Agent Extension Updater" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 0: Setup Node.js
Write-Host "[0/6] Checking Node.js..." -ForegroundColor Yellow
if (-not (Setup-NodeJS)) {
    Write-Host "      Node.js setup failed. Aborting." -ForegroundColor Red
    exit 1
}
Write-Host "      Node.js ready" -ForegroundColor Green

$extensionPath = "D:\mycode\Ziner\extensions\coding-agent"

# Step 1: Clean old builds
Write-Host ""
Write-Host "[1/6] Cleaning old builds..." -ForegroundColor Yellow

$outPath = Join-Path $extensionPath "out"
if (Test-Path $outPath) {
    Remove-Item -Recurse -Force $outPath
    Write-Host "      Deleted out/ directory" -ForegroundColor Green
}
$tsBuildInfo = Join-Path $extensionPath "tsconfig.tsbuildinfo"
if (Test-Path $tsBuildInfo) {
    Remove-Item $tsBuildInfo -Force
    Write-Host "      Deleted tsbuildinfo cache" -ForegroundColor Green
}

$oldVsix = Get-ChildItem -Path $extensionPath -Filter "*.vsix"
if ($oldVsix) {
    $oldVsix | ForEach-Object { 
        Remove-Item $_.FullName
        Write-Host "      Deleted old file: $($_.Name)" -ForegroundColor Green
    }
}

# Step 2: Install dependencies
Write-Host ""
Write-Host "[2/6] Checking dependencies..." -ForegroundColor Yellow
if (-not (Ensure-Dependencies $extensionPath)) {
    exit 1
}

# Step 3: Compile TypeScript
Write-Host ""
Write-Host "[3/6] Compiling TypeScript..." -ForegroundColor Yellow
$tsConfigPath = Join-Path $extensionPath "tsconfig.json"
$tscPath = Join-Path $extensionPath "node_modules\typescript\bin\tsc"

if (Test-Path $tscPath) {
    & "$nodePath\node.exe" "$tscPath" -p "$tsConfigPath"
} else {
    Write-Host "      tsc not found, installing typescript..." -ForegroundColor Yellow
    Push-Location $extensionPath
    & "$nodePath\npm.cmd" install typescript --save-dev
    Pop-Location
    & "$nodePath\node.exe" "$tscPath" -p "$tsConfigPath"
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "      Compilation failed with exit code: $LASTEXITCODE" -ForegroundColor Red
    Write-Host "      Check the error messages above and fix them." -ForegroundColor Yellow
    exit 1
}
Write-Host "      Compilation successful" -ForegroundColor Green

# Step 4: Update version (optional)
Write-Host ""
Write-Host "[4/6] Checking version..." -ForegroundColor Yellow
$packageJsonPath = Join-Path $extensionPath "package.json"
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
Write-Host "[5/6] Packaging extension..." -ForegroundColor Yellow

Push-Location $extensionPath
Ensure-Vsce $extensionPath

# Try vsce (local install), fall back to npx
$vscePath = Join-Path $extensionPath "node_modules\@vscode\vsce\out\vsce"
if (Test-Path "$vscePath.js") {
    & "$nodePath\node.exe" "$vscePath.js" package --no-dependencies
} else {
    & "$nodePath\node.exe" "$nodePath\node_modules\npm\bin\npx-cli.js" -y @vscode/vsce package --no-dependencies
}
Pop-Location

if ($LASTEXITCODE -ne 0) {
    Write-Host "      Packaging failed (this may be non-critical)" -ForegroundColor Yellow
    Write-Host "      The compiled output is still available in out/" -ForegroundColor Yellow
}

# Step 6: Show results
Write-Host ""
Write-Host "[6/6] Finalizing..." -ForegroundColor Yellow

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
    
    $autoInstall = Read-Host "Auto install in VS Code? (y/n, default: n)"
    if ($autoInstall -eq "y" -or $autoInstall -eq "Y") {
        $codeCmd = Get-Command "code" -ErrorAction SilentlyContinue
        if ($codeCmd) {
            # Uninstall old marketplace version if present
            $oldId = "545042115.coding-agent"
            $installed = & code --list-extensions 2>&1
            if ($installed -match [regex]::Escape($oldId)) {
                Write-Host "      Uninstalling old version ($oldId)..." -ForegroundColor Yellow
                & code --uninstall-extension $oldId 2>&1 | Out-Null
            }
            $installResult = & code --install-extension $vsixFile.FullName --force 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Host "      Installed to VS Code" -ForegroundColor Green
            } else {
                Write-Host "      Auto-install failed: $installResult" -ForegroundColor Yellow
                Write-Host "      Please install manually from VSIX file" -ForegroundColor White
            }
        } else {
            Write-Host "      code command not found, please install manually" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "      .vsix file was not created" -ForegroundColor Yellow
    Write-Host "      The extension output is still available in out/" -ForegroundColor Cyan
    Write-Host "      You can manually package with: cd extensions\coding-agent && npx @vscode/vsce package" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
