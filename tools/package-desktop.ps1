<#
.SYNOPSIS
One-click build Z Assistant Desktop Windows installer (.exe)
#>

param(
  [switch]$SkipInstall,
  [string]$OutDir = ""
)

$RootDir = Split-Path -Parent $PSScriptRoot
$DesktopDir = Join-Path $RootDir "apps\desktop"
$DistDir = if ($OutDir) { $OutDir } else { Join-Path $DesktopDir "dist" }

function Write-Step($Title) {
  Write-Host ""
  Write-Host ">> $Title" -ForegroundColor Yellow
}

# -- 1. Check environment --
Write-Step "[1/5] Check environment"

$nodeVer = node --version 2>$null
if (-not $nodeVer) {
  Write-Host "  ERROR: Node.js not found, install Node.js 18+" -ForegroundColor Red
  exit 1
}
Write-Host "  [OK] Node.js $nodeVer" -ForegroundColor Green

$npmVer = npm --version 2>$null
if (-not $npmVer) {
  Write-Host "  ERROR: npm not found" -ForegroundColor Red
  exit 1
}
Write-Host "  [OK] npm v$npmVer" -ForegroundColor Green

# -- 2. Install dependencies --
if (-not $SkipInstall) {
  Write-Step "[2/5] Install dependencies"

  # Use Chinese mirror for Electron if available (much faster in CN)
  if ([string]::IsNullOrEmpty($env:ELECTRON_MIRROR)) {
    $electronMirror = "https://npmmirror.com/mirrors/electron/"
    Write-Host "  Set ELECTRON_MIRROR=$electronMirror (CN mirror)" -ForegroundColor Gray
    $env:ELECTRON_MIRROR = $electronMirror
  }

  Write-Host "  npm install (root) - installing all workspace deps..." -ForegroundColor Gray
  Push-Location $RootDir
  npm install --loglevel=error 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Host "  ERROR: npm install root failed (exit $LASTEXITCODE)" -ForegroundColor Red; Pop-Location; exit 1 }
  Pop-Location

  Write-Host "  [OK] Dependencies installed" -ForegroundColor Green
} else {
  Write-Step "[2/5] Skip dependency installation"
}

# -- 3. Build workspace dependencies --
Write-Step "[3/5] Build workspace dependencies"

Push-Location $RootDir

# Build in strict dependency order (TypeScript project references)
$buildOrder = @(
  "@z-assistant/contracts",
  "@z-assistant/infra-errors",
  "@z-assistant/infra-storage",
  "@z-assistant/infra-cost",
  "@z-assistant/infra-config",
  "@z-assistant/infra-permission",
  "@z-assistant/trace",
  "@z-assistant/runtime",
  "@z-assistant/agent-coding",
  "@z-assistant/agent-browser",
  "@z-assistant/app-vscode-connector"
)

foreach ($pkg in $buildOrder) {
  Write-Host "  Building $pkg..." -ForegroundColor Gray
  npm run build --workspace=$pkg 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Host "  ERROR: $pkg build failed" -ForegroundColor Red; Pop-Location; exit 1 }
  Write-Host "  [OK] $pkg" -ForegroundColor Green
}

Pop-Location

# -- 4. Build desktop --
Write-Step "[4/5] Build Desktop TypeScript"

Push-Location $DesktopDir
npm run build 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "  ERROR: Desktop build failed" -ForegroundColor Red; Pop-Location; exit 1 }
Write-Host "  [OK] Desktop TypeScript compiled" -ForegroundColor Green
Pop-Location

# -- 5. Manual portable EXE (bypass app-builder.exe blocked by antivirus) --
Write-Step "[5/5] Package portable EXE (manual)"

Push-Location $DesktopDir

# Step A: ensure we have a clean Electron base
$unpackedDir = Join-Path $DistDir "win-unpacked"
$appDir = Join-Path $unpackedDir "resources\app"
# Electron dist is hoisted to the root node_modules (npm workspace)
$electronDist = Join-Path $RootDir "node_modules\electron\dist"

# Kill any running instances BEFORE copying files
taskkill /f /im "Z Assistant.exe" 2>$null
taskkill /f /im electron.exe 2>$null
Start-Sleep -Seconds 2

# Clean old build artifacts to avoid dll locking issues
if (Test-Path $unpackedDir) {
  Write-Host "  Cleaning old build artifacts..."
  Remove-Item -Path "$unpackedDir\*" -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "  Copying Electron base..."
if (-not (Test-Path $electronDist\electron.exe)) {
  Write-Host "  ERROR: electron dist not found at $electronDist" -ForegroundColor Red
  Pop-Location; exit 1
}
# Full copy of Electron binaries
New-Item -ItemType Directory -Force -Path $unpackedDir | Out-Null
Copy-Item -Path "$electronDist\*" -Destination $unpackedDir -Recurse -Force
# Also ensure resources/app exists
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# Step C: copy app code into resources/app
Write-Host "  Copying app code..."
# Ensure clean app directory
Remove-Item -Path "$appDir\*" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
# Copy compiled output (use robocopy for reliability with mixed files/dirs)
robocopy "$DesktopDir\out" "$appDir\out" /E /NJH /NJS /NDL /NP 2>&1 | Out-Null
# Copy package.json (for Electron to find main entry)
Copy-Item -Path "$DesktopDir\package.json" -Destination "$appDir\package.json" -Force
# Copy build config (icon etc.)
if (Test-Path "$DesktopDir\build") {
  New-Item -ItemType Directory -Force -Path "$appDir\build" | Out-Null
  robocopy "$DesktopDir\build" "$appDir\build" /E /NJH /NJS /NDL /NP 2>&1 | Out-Null
}

# Step D: copy workspace packages (@z-assistant/*) into app's node_modules
Write-Host "  Copying workspace packages..."
$appNodeModules = Join-Path $unpackedDir "resources\app\node_modules"
$zAssistantDst = Join-Path $appNodeModules "@z-assistant"
$neededPackages = @(
  @{Name="app-vscode-connector"; Source="apps\vscode-connector"}
  @{Name="agent-browser";       Source="packages\agents\browser-agent"}
  @{Name="agent-coding";        Source="packages\agents\coding-agent"}
  @{Name="runtime";             Source="packages\runtime"}
  @{Name="trace";               Source="packages\trace"}
  @{Name="infra-storage";       Source="packages\infra\storage"}
  @{Name="infra-cost";          Source="packages\infra\cost"}
  @{Name="infra-errors";        Source="packages\infra\errors"}
  @{Name="infra-config";        Source="packages\infra\config"}
  @{Name="infra-permission";    Source="packages\infra\permission"}
  @{Name="contracts";           Source="packages\contracts"}
)

New-Item -ItemType Directory -Force -Path $zAssistantDst | Out-Null
foreach ($pkg in $neededPackages) {
  $srcDir = Join-Path $RootDir $pkg.Source
  $dstDir = Join-Path $zAssistantDst $pkg.Name
  if (Test-Path "$srcDir\out") {
    New-Item -ItemType Directory -Force -Path "$dstDir\out" | Out-Null
    # Copy compiled JS output
    Copy-Item -Path "$srcDir\out\*" -Destination "$dstDir\out\" -Recurse -Force -ErrorAction SilentlyContinue
    # Copy package.json (needed for main field resolution)
    Copy-Item -Path "$srcDir\package.json" -Destination "$dstDir\package.json" -Force
  }
}

# Step D2: recursively copy all third-party dependencies
# Walks the FULL dependency closure of apps/desktop, including workspace
# packages (e.g. @z-assistant/app-vscode-connector) and their deps.
# This catches transitive deps like @modelcontextprotocol/sdk which are
# declared by workspace packages but not by apps/desktop directly.
Write-Host "  Installing runtime dependencies (recursive closure)..."
$rootNodeModules = Join-Path $RootDir "node_modules"
$appNodeModules = Join-Path $unpackedDir "resources\app\node_modules"

# Track copied packages to avoid infinite loops
$script:copiedPkgs = @{}
# Track missing third-party packages (so we can warn at the end)
$script:missingPkgs = @{}
# Directories we have already visited to read package.json
$script:visitedDirs = @{}

function Copy-PkgRecursive {
  param([string]$PkgName, [string]$PkgSubDir = "")
  $srcPath = if ($PkgSubDir) { Join-Path $rootNodeModules "$PkgSubDir\$PkgName" } else { Join-Path $rootNodeModules $PkgName }
  $dstPath = if ($PkgSubDir) { Join-Path $appNodeModules "$PkgSubDir\$PkgName" } else { Join-Path $appNodeModules $PkgName }
  $cacheKey = if ($PkgSubDir) { "$PkgSubDir/$PkgName" } else { $PkgName }

  if ($script:copiedPkgs.ContainsKey($cacheKey)) { return }

  if (-not (Test-Path $srcPath)) {
    # If a third-party package is missing in root node_modules, remember it
    # and skip — workspace packages may be missing because they live only
    # in their source directory.
    if ($PkgSubDir -and $PkgSubDir.StartsWith('@')) {
      $script:missingPkgs[$cacheKey] = $true
    } elseif ($PkgName -notlike '@*') {
      $script:missingPkgs[$cacheKey] = $true
    }
    return
  }

  # Mark as copied BEFORE copying so nested calls don't recurse forever
  $script:copiedPkgs[$cacheKey] = $true

  # Copy the package directory
  New-Item -ItemType Directory -Force -Path $dstPath | Out-Null
  Copy-Item -Path "$srcPath\*" -Destination $dstPath -Recurse -Force -ErrorAction SilentlyContinue

  # Read package.json to find dependencies (declare once per directory)
  if (-not $script:visitedDirs.ContainsKey($srcPath)) {
    $script:visitedDirs[$srcPath] = $true
    $pkgJson = Join-Path $srcPath "package.json"
    if (Test-Path $pkgJson) {
      try {
        $json = Get-Content $pkgJson -Raw | ConvertFrom-Json
        foreach ($depField in @('dependencies', 'optionalDependencies', 'peerDependencies')) {
          $deps = $json.$depField
          if ($deps) {
            foreach ($prop in $deps.PSObject.Properties) {
              $depName = $prop.Name
              # Skip only known irrelevant top-level tools (e.g. @types/*)
              if ($depName -like '@types/*') { continue }
              if ($depName -like '@*/*') {
                $scope = $depName.Split('/')[0]
                $name = $depName.Split('/')[1]
                Copy-PkgRecursive -PkgName $name -PkgSubDir $scope
              } else {
                Copy-PkgRecursive -PkgName $depName
              }
            }
          }
        }
      } catch {}
    }
  }
}

# Start from apps/desktop's package.json AND recurse into every workspace
# package it transitively depends on. This is required because workspace
# packages (e.g. @z-assistant/app-vscode-connector) declare their own
# runtime deps which won't be visible from apps/desktop alone.
$rootPkg = Join-Path $RootDir "package.json"
$rootJson = if (Test-Path $rootPkg) { Get-Content $rootPkg -Raw | ConvertFrom-Json } else { $null }
$workspaceDirs = @()
if ($rootJson -and $rootJson.workspaces) {
  $workspaceDirs = @($rootJson.workspaces)
}

$entryPoints = @(
  Join-Path $RootDir "apps/desktop/package.json"
)
foreach ($ws in $workspaceDirs) {
  foreach ($p in @(Get-Item (Join-Path $RootDir $ws) -ErrorAction SilentlyContinue)) {
    $pkgJson = Join-Path $p.FullName "package.json"
    if (Test-Path $pkgJson) { $entryPoints += $pkgJson }
  }
}

foreach ($entry in $entryPoints) {
  if (-not (Test-Path $entry)) { continue }
  $json = Get-Content $entry -Raw | ConvertFrom-Json
  foreach ($prop in $json.dependencies.PSObject.Properties) {
    $depName = $prop.Name
    if ($depName -like '@types/*') { continue }
    if ($depName -like '@*/*') {
      $scope = $depName.Split('/')[0]
      $name = $depName.Split('/')[1]
      Copy-PkgRecursive -PkgName $name -PkgSubDir $scope
    } else {
      Copy-PkgRecursive -PkgName $depName
    }
  }
}

Write-Host "  [OK] Runtime dependencies installed ($($script:copiedPkgs.Count) packages)" -ForegroundColor Green
if ($script:missingPkgs.Count -gt 0) {
  Write-Host "  [WARN] Missing packages (not found in root node_modules):" -ForegroundColor Yellow
  $script:missingPkgs.Keys | Sort-Object | ForEach-Object { Write-Host "    - $_" -ForegroundColor Yellow }
}

# Re-name the exe
$targetExe = Join-Path $unpackedDir "Z Assistant.exe"
if (Test-Path "$unpackedDir\electron.exe") {
  Rename-Item -Path "$unpackedDir\electron.exe" -NewName "Z Assistant.exe" -Force -ErrorAction SilentlyContinue
}

Write-Host "  [OK] Portable EXE ready" -ForegroundColor Green
$exitCode = 0

Pop-Location

if ($exitCode -ne 0) {
  Write-Host ""
  Write-Host "WARNING: Packaging failed (exit $exitCode)" -ForegroundColor Yellow
  Write-Host "  antivirus may be blocking app-builder.exe" -ForegroundColor Gray
  Write-Host "  Portable exe may already exist in:" -ForegroundColor Gray
  Write-Host "  $DistDir\win-unpacked\" -ForegroundColor Gray
} else {
  Write-Host ""
  Write-Host "  [OK] Package completed!" -ForegroundColor Green
}

# -- Check output --
Write-Host ""
Write-Host "================================" -ForegroundColor Cyan
Write-Host "  Checking output..." -ForegroundColor Yellow

if (Test-Path $DistDir) {
  $exeFiles = Get-ChildItem -Path $DistDir -Filter "*.exe" -Recurse | Sort-Object LastWriteTime -Descending
  if ($exeFiles) {
    foreach ($f in $exeFiles) {
      $size = "{0:N1} MB" -f ($f.Length / 1MB)
      Write-Host "  >> $($f.FullName)  ($size)" -ForegroundColor Green
    }
  } else {
    Write-Host "  No .exe found in $DistDir, check directories:" -ForegroundColor Yellow
    Get-ChildItem -Path $DistDir -Recurse -Directory | ForEach-Object {
      Write-Host "     $($_.FullName)" -ForegroundColor Gray
    }
  }
} else {
  Write-Host "  $DistDir does not exist" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Tip: dev mode (no packaging):" -ForegroundColor Magenta
Write-Host "  npm run build --workspaces --if-present" -ForegroundColor White
Write-Host "  npm run start -w apps/desktop" -ForegroundColor White
Write-Host ""
