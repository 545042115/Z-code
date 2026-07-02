$data = @{
  'runtime' = 'F:\Ziner\packages\runtime'
  'trace' = 'F:\Ziner\packages\trace'
  'infra-storage' = 'F:\Ziner\packages\infra\storage'
  'infra-cost' = 'F:\Ziner\packages\infra\cost'
  'infra-errors' = 'F:\Ziner\packages\infra\errors'
  'contracts' = 'F:\Ziner\packages\contracts'
}
foreach ($key in $data.Keys) {
  $path = $data[$key]
  $deps = (Get-Content "$path\package.json" | ConvertFrom-Json).dependencies
  if ($deps) {
    $ext = @()
    foreach ($k in $deps.PSObject.Properties.Name) {
      if (-not $k.StartsWith('@ziner/')) { $ext += $k }
    }
    if ($ext.Count -gt 0) {
      Write-Host "$key external: $($ext -join ',')"
    } else {
      Write-Host "$key : only @ziner deps"
    }
  } else {
    Write-Host "$key : no deps"
  }
}
