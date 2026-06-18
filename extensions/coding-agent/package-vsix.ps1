# Build and package the Coding Agent extension as VSIX.
# Depends on postcompile.mjs (runs after tsc in "npm run compile").

param(
  [string]$ExtDir = (Get-Location).Path
)

Write-Host "=== Step 1: Compiling extension (tsc + postcompile) ==="
Push-Location $ExtDir
npm run compile 2>&1
if ($LASTEXITCODE -ne 0) { throw "Compilation failed" }
Pop-Location

Write-Host "=== Step 2: Creating .vscodeignore ==="
$OutDir = "$ExtDir\temp-vsix"
if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

Copy-Item -Recurse "$ExtDir\out" "$OutDir\out"
if (Test-Path "$ExtDir\media") { Copy-Item -Recurse "$ExtDir\media" "$OutDir\media" }
Copy-Item "$ExtDir\package.json" "$OutDir\package.json"
Copy-Item "$ExtDir\README.md" "$OutDir\README.md"
Copy-Item "$ExtDir\LICENSE" "$OutDir\LICENSE"

@"
**/__tests__/**
**/*.map
**/*.tsbuildinfo
"@ | Set-Content "$OutDir\.vscodeignore"

# Fix vscode:prepublish to skip compilation
$pkgJson = Get-Content "$OutDir\package.json" -Raw
$pkgJson = $pkgJson -replace '"vscode:prepublish".*', '"vscode:prepublish": "echo prepublish skipped",'
Set-Content "$OutDir\package.json" $pkgJson

Write-Host "=== Step 3: Creating VSIX ==="
Push-Location $OutDir
npx vsce package --no-dependencies -o "$ExtDir\coding-agent-1.2.0.vsix" 2>&1
$result = $LASTEXITCODE
Pop-Location
Remove-Item -Recurse -Force $OutDir

if ($result -eq 0) {
  Write-Host "=== DONE ===" -ForegroundColor Green
  Write-Host "VSIX: $ExtDir\coding-agent-1.2.0.vsix"
} else {
  Write-Host "=== FAILED ===" -ForegroundColor Red
}
