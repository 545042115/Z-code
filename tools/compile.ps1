# PowerShell script to compile VS Code extension
$nodePath = "D:\mycode\Z Code\tools\node-v20.14.0-win-x64"
$env:PATH = "$nodePath;$env:PATH"

Set-Location "D:\mycode\Z Code\extensions\coding-agent"

# Install TypeScript locally if not exists
if (-not (Test-Path "node_modules\typescript")) {
    & "$nodePath\npm.cmd" install typescript --save-dev
}

# Compile
& "$nodePath\node.exe" "node_modules\typescript\bin\tsc" -p ./

Write-Host "Compilation complete!"
