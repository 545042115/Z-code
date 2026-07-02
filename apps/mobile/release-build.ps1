# Ziner Mobile - Release Build Script
#
# Builds a signed Release APK that can be installed directly on a phone
# (no developer mode / no ADB required).
#
# Usage:    powershell -ExecutionPolicy Bypass -File release-build.ps1
# Or just:  .\release-build.ps1
#
# Output:   android\app\build\outputs\apk\release\app-release.apk

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$apkName = "app-release.apk"
$apkPath = Join-Path $root "android\app\build\outputs\apk\release\$apkName"

# Use project-local gradle home to avoid C: drive space issues
$gradleHome = Join-Path $root ".gradle-home"
if (-not (Test-Path $gradleHome)) {
    New-Item -ItemType Directory -Path $gradleHome -Force | Out-Null
}
$env:GRADLE_USER_HOME = $gradleHome
Write-Host "GRADLE_USER_HOME=$gradleHome" -ForegroundColor DarkGray

# Set JAVA_HOME for gradle (override by setting env var before running)
if (-not $env:JAVA_HOME) {
    $jdkPath = "D:\android\JDK19"
    if (Test-Path $jdkPath) {
        $env:JAVA_HOME = $jdkPath
        $env:Path = "$jdkPath\bin;$env:Path"
        Write-Host "Using JAVA_HOME=$jdkPath" -ForegroundColor DarkGray
    } else {
        throw "JAVA_HOME not set and default JDK path $jdkPath not found. Set JAVA_HOME environment variable first."
    }
}

# Set ANDROID_HOME (use existing local SDK; override by setting env var before running)
if (-not $env:ANDROID_HOME) {
    $sdkPath = "D:\android\SDK"
    if (Test-Path (Join-Path $sdkPath "platform-tools\adb.exe")) {
        $env:ANDROID_HOME = $sdkPath
        $env:ANDROID_SDK_ROOT = $sdkPath
        Write-Host "Using ANDROID_HOME=$sdkPath" -ForegroundColor DarkGray
    } else {
        throw "ANDROID_HOME not set and default SDK path $sdkPath not found. Set ANDROID_HOME environment variable first."
    }
}

Write-Host "=== Ziner Mobile Release Build ===" -ForegroundColor Cyan
Write-Host "Root: $root"
Write-Host ""

# 1. Build web assets and sync to Android
Write-Host "[1/3] Building web assets + cap sync..." -ForegroundColor Yellow
Push-Location $root
try {
    npm run cap:build
    if ($LASTEXITCODE -ne 0) { throw "cap:build failed" }
}
finally {
    Pop-Location
}

# 2. Run gradle assembleRelease
Write-Host ""
Write-Host "[2/3] Running gradle assembleRelease..." -ForegroundColor Yellow
Push-Location (Join-Path $root "android")
try {
    & ".\gradlew.bat" assembleRelease
    if ($LASTEXITCODE -ne 0) { throw "gradle assembleRelease failed" }
}
finally {
    Pop-Location
}

# 3. Verify APK exists
Write-Host ""
if (Test-Path $apkPath) {
    $size = (Get-Item $apkPath).Length
    $sizeMB = [math]::Round($size / 1MB, 2)
    Write-Host "[3/3] Done!" -ForegroundColor Green
    Write-Host ""
    Write-Host "APK generated:" -ForegroundColor Green
    Write-Host "  Path: $apkPath" -ForegroundColor White
    Write-Host "  Size: $sizeMB MB" -ForegroundColor White
    Write-Host ""
    Write-Host "Install on phone:" -ForegroundColor Cyan
    Write-Host "  1. Copy APK to phone (WeChat file transfer / USB / cloud drive)"
    Write-Host "  2. Phone Settings -> Security -> Allow file manager to install unknown apps"
    Write-Host "  3. Open APK with file manager and tap install"
    Write-Host ""
    Write-Host "For upgrades:" -ForegroundColor Cyan
    Write-Host "  Edit android/app/build.gradle -> versionCode / versionName"
    Write-Host "  Re-run this script and reinstall the new APK"
} else {
    Write-Host "[3/3] Failed: APK not found" -ForegroundColor Red
    exit 1
}
