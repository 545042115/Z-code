$data = @{
  'runtime' = 'F:\Z-code\packages\runtime'
  'trace' = 'F:\Z-code\packages\trace'
  'infra-storage' = 'F:\Z-code\packages\infra\storage'
  'infra-cost' = 'F:\Z-code\packages\infra\cost'
  'infra-errors' = 'F:\Z-code\packages\infra\errors'
  'contracts' = 'F:\Z-code\packages\contracts'
}
foreach ($key in $data.Keys) {
  $path = $data[$key]
  $deps = (Get-Content "$path\package.json" | ConvertFrom-Json).dependencies
  if ($deps) {
    $ext = @()
    foreach ($k in $deps.PSObject.Properties.Name) {
      if (-not $k.StartsWith('@z-assistant/')) { $ext += $k }
    }
    if ($ext.Count -gt 0) {
      Write-Host "$key external: $($ext -join ',')"
    } else {
      Write-Host "$key : only @z-assistant deps"
    }
  } else {
    Write-Host "$key : no deps"
  }
}
