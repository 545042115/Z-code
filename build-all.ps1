<#
.SYNOPSIS
    Z Assistant 完整构建脚本
    一键完成: Python 环境配置 + TS 编译 + Python 侧车打包 + Electron 应用打包
#>

param(
    [ValidateSet('release', 'debug')]
    [string]$Config = 'release',
    [switch]$SkipPython,
    [switch]$SkipDesktop,
    [switch]$SkipPythonDeps,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$rootDir = $PSScriptRoot
$pyDir = "$rootDir\packages\runtime\python"
$venvDir = "$pyDir\.venv"
$markerFile = "$pyDir\.deps-installed"
$reqFile = "$pyDir\requirements.txt"
$reqHashFile = "$pyDir\.requirements-hash"

function Write-Step { param([string]$msg); Write-Host "`n--- $msg ---" -ForegroundColor Cyan }

# ── 0. Clean ─────────────────────────────────────────────────────────
if ($Clean) {
    Write-Step "0/6 Clean"
    $dirs = @(
        "$rootDir\packages\contracts\out",
        "$rootDir\packages\runtime\out",
        "$rootDir\packages\runtime\python\dist",
        "$rootDir\packages\runtime\python\build",
        "$rootDir\packages\agents\browser-agent\out",
        "$rootDir\apps\vscode-connector\out",
        "$rootDir\apps\desktop\out",
        "$rootDir\apps\desktop\dist"
    )
    foreach ($d in $dirs) { if (Test-Path $d) { Remove-Item -Recurse -Force $d; Write-Host "  cleaned: $d" } }
    # Also remove venv + markers so deps get reinstalled next time
    if (Test-Path $venvDir) { Remove-Item -Recurse -Force $venvDir; Write-Host "  cleaned: .venv" }
    if (Test-Path $markerFile) { Remove-Item -Force $markerFile }
    if (Test-Path $reqHashFile) { Remove-Item -Force $reqHashFile }
}

# ── 1. Python 环境准备 ───────────────────────────────────────────────
if (-not $SkipPythonDeps) {
    Write-Step "1/6 Python environment"

    # 1a. Find Python
    $pythonExe = $null
    $pkgManager = $null

    # Try uv first (fastest)
    $uvPath = (Get-Command 'uv' -ErrorAction SilentlyContinue).Source
    if ($uvPath) {
        Write-Host "  Using uv: $uvPath" -ForegroundColor Green
        $pkgManager = 'uv'
        $pythonExe = "$venvDir\Scripts\python.exe"
    } else {
        # Try conda
        $condaPath = (Get-Command 'conda' -ErrorAction SilentlyContinue).Source
        if ($condaPath) {
            Write-Host "  Using conda: $condaPath" -ForegroundColor Green
            $pkgManager = 'conda'
            $pythonExe = "$venvDir\Scripts\python.exe"
        } else {
            # Find a real Python (skip WindowsApps stub)
            $pythonExe = $null
            $candidates = @(
                (Get-Command 'python3' -ErrorAction SilentlyContinue).Source
                (Get-Command 'python' -ErrorAction SilentlyContinue).Source
            )
            foreach ($c in $candidates) {
                if ($c -and $c -notlike '*WindowsApps*') {
                    # Verify it's a real Python
                    $ver = & $c --version 2>&1
                    if ($LASTEXITCODE -eq 0 -and $ver -match 'Python 3\.(\d+)') {
                        $pythonExe = $c
                        break
                    }
                }
            }
            if ($pythonExe) {
                Write-Host "  Using system python: $pythonExe" -ForegroundColor Green
                $pkgManager = 'pip'
            } else {
                Write-Host "  [WARN] Python 3.8+ not found. Install Python or uv, then re-run." -ForegroundColor Yellow
                Write-Host "  Install uv: winget install astral.uv  or  https://docs.astral.sh/uv/" -ForegroundColor Yellow
            }
        }
    }

    # 1b. Create venv if needed
    if ($pythonExe -and (-not (Test-Path "$venvDir\Scripts\python.exe"))) {
        Write-Host "  Creating virtual environment..."
        if ($pkgManager -eq 'uv') {
            uv venv "$venvDir" 2>&1
        } elseif ($pkgManager -eq 'conda') {
            conda create -p "$venvDir" python=3.11 -y 2>&1
        } else {
            & $pythonExe -m venv "$venvDir" 2>&1
        }
        if ($LASTEXITCODE -ne 0) { throw "Failed to create virtual environment" }
        Write-Host "  [OK] Virtual environment created at $venvDir" -ForegroundColor Green
    }

    # 1c. Install dependencies (skip if already installed and requirements unchanged)
    $needInstall = $true
    if ((Test-Path $markerFile) -and (Test-Path $reqHashFile)) {
        $oldHash = Get-Content $reqHashFile -Raw
        $newHash = (Get-FileHash $reqFile -Algorithm SHA256).Hash
        if ($oldHash -eq $newHash) {
            $needInstall = $false
            Write-Host "  [OK] Dependencies already installed and requirements unchanged, skipping" -ForegroundColor Green
        } else {
            Write-Host "  Requirements changed, reinstalling..." -ForegroundColor Yellow
        }
    }

    if ($needInstall -and $pythonExe) {
        Write-Host "  Installing Python dependencies..."
        if ($pkgManager -eq 'uv') {
            uv pip install -r "$reqFile" --python "$venvDir\Scripts\python.exe" 2>&1
        } elseif ($pkgManager -eq 'conda') {
            & "$venvDir\Scripts\python.exe" -m pip install -r "$reqFile" 2>&1
        } else {
            & "$venvDir\Scripts\python.exe" -m pip install -r "$reqFile" 2>&1
        }
        if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

        # Write marker files
        Set-Content -Path $markerFile -Value "installed" -NoNewline
        $hash = (Get-FileHash $reqFile -Algorithm SHA256).Hash
        Set-Content -Path $reqHashFile -Value $hash -NoNewline
        Write-Host "  [OK] Dependencies installed" -ForegroundColor Green
    }

    # 1d. Install PyInstaller (for packaging sidecar)
    if ($pythonExe) {
        $hasPyInstaller = & "$venvDir\Scripts\python.exe" -c "import PyInstaller; print('ok')" 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Installing PyInstaller..."
            if ($pkgManager -eq 'uv') {
                uv pip install pyinstaller --python "$venvDir\Scripts\python.exe" 2>&1
            } else {
                & "$venvDir\Scripts\python.exe" -m pip install pyinstaller 2>&1
            }
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  [OK] PyInstaller installed" -ForegroundColor Green
            }
        } else {
            Write-Host "  [OK] PyInstaller already installed" -ForegroundColor Green
        }
    }
} else {
    Write-Step "1/6 Skip Python deps"
}

# ── 2. Build TypeScript ──────────────────────────────────────────────
Write-Step "2/6 Build TypeScript"

# Patch 7za to ignore exit code 2 (macOS symlinks in winCodeSign)
$7zaDir = "$rootDir\node_modules\7zip-bin\win\x64"
$7zaReal = "$7zaDir\7za_real.exe"
if ((Test-Path "$7zaDir\7za.exe") -and -not (Test-Path $7zaReal)) {
    Write-Host "  Patching 7za.exe to ignore exit code 2..."
    Move-Item "$7zaDir\7za.exe" $7zaReal -Force
    $csCode = @'
using System;
using System.Diagnostics;
using System.IO;
class Program {
    static int Main(string[] args) {
        var psi = new ProcessStartInfo {
            FileName = Path.Combine(Path.GetDirectoryName(typeof(Program).Assembly.Location), "7za_real.exe"),
            Arguments = string.Join(" ", args),
            UseShellExecute = false
        };
        var p = Process.Start(psi);
        p.WaitForExit();
        return p.ExitCode == 2 ? 0 : p.ExitCode;
    }
}
'@
    Add-Type -TypeDefinition $csCode -Language CSharp -OutputAssembly "$7zaDir\7za.exe" -OutputType ConsoleApplication -ReferencedAssemblies @() 2>&1 | Out-Null
    if (Test-Path "$7zaDir\7za.exe") {
        Write-Host "  [OK] 7za.exe patched" -ForegroundColor Green
    }
}

# Set signing env vars (no certs available)
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
$env:CSC_LINK = ''
$env:CSC_KEY_PASSWORD = ''
$env:WIN_CSC_LINK = ''
$env:WIN_CSC_KEY_PASSWORD = ''
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$pkgs = @(
    "$rootDir\packages\contracts",
    "$rootDir\packages\runtime",
    "$rootDir\packages\agents\browser-agent",
    "$rootDir\apps\vscode-connector",
    "$rootDir\apps\desktop"
)
foreach ($pkg in $pkgs) {
    $name = Split-Path -Leaf $pkg
    Write-Host "  [$name] npm run build..."
    Push-Location $pkg
    npm run build 2>&1
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed in $pkg" }
    Pop-Location
}

# ── 3. Typecheck ────────────────────────────────────────────────────
Write-Step "3/6 Typecheck"
Push-Location "$rootDir\apps\desktop"
npm run typecheck 2>&1
if ($LASTEXITCODE -ne 0) { throw "Typecheck failed" }
Pop-Location

# ── 4. Build Python sidecar ─────────────────────────────────────────
if (-not $SkipPython) {
    Write-Step "4/6 Build Python sidecar (perception-server.exe)"

    $venvPython = "$venvDir\Scripts\python.exe"
    $venvPyInstaller = "$venvDir\Scripts\pyinstaller.exe"

    if (-not (Test-Path $venvPython)) {
        Write-Host "  [WARN] Virtual environment not found, skipping" -ForegroundColor Yellow
    } elseif (-not (Test-Path $venvPyInstaller)) {
        Write-Host "  [WARN] PyInstaller not found in venv, skipping" -ForegroundColor Yellow
    } else {
        if (Test-Path "$pyDir\dist") { Remove-Item -Recurse -Force "$pyDir\dist" }
        if (Test-Path "$pyDir\build") { Remove-Item -Recurse -Force "$pyDir\build" }

        Write-Host "  Running PyInstaller..."
        Push-Location $pyDir
        & $venvPyInstaller perception-server.spec --clean --noconfirm 2>&1
        Pop-Location

        $exe = "$pyDir\dist\perception-server.exe"
        if (Test-Path $exe) {
            $size = "{0:N1} MB" -f ((Get-Item $exe).Length / 1MB)
            Write-Host "  [OK] perception-server.exe ($size)" -ForegroundColor Green
        } else {
            Write-Host "  [WARN] perception-server.exe not found" -ForegroundColor Yellow
        }
    }
} else {
    Write-Step "4/6 Skip Python sidecar"
}

# ── 5. Package desktop app ──────────────────────────────────────────
if (-not $SkipDesktop) {
    Write-Step "5/6 Package desktop app"
    $ebCli = "$rootDir\node_modules\electron-builder\cli.js"
    if (-not (Test-Path $ebCli)) {
        Write-Host "  [WARN] electron-builder not found, skipping" -ForegroundColor Yellow
    } else {
        Write-Host "  Running electron-builder..."
        Push-Location "$rootDir\apps\desktop"
        $env:ELECTRON_VERSION = '30.5.1'
        node $ebCli --config build/electron-builder.json 2>&1
        Pop-Location
        $dist = "$rootDir\apps\desktop\dist"
        if (Test-Path $dist) {
            Write-Host "  Output:" -ForegroundColor Cyan
            Get-ChildItem $dist | ForEach-Object {
                if ($_.Length) {
                    $s = "{0:N1} MB" -f ($_.Length / 1MB)
                    Write-Host "    $($_.Name)  $s"
                } else {
                    Write-Host "    $($_.Name)  (dir)"
                }
            }
        }
    }
} else {
    Write-Step "5/6 Skip desktop packaging"
}

# ── 6. Done ─────────────────────────────────────────────────────────
Write-Step "6/6 Done"
Write-Host "  [OK] Build complete" -ForegroundColor Green
Write-Host ""
Write-Host "  Quick start: cd apps\desktop; npx electron ."
Write-Host "  Full build:  .\build-all.ps1"
