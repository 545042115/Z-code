Add-Type -AssemblyName System.Drawing

$colorStart = [System.Drawing.Color]::FromArgb(74, 106, 142)
$colorEnd   = [System.Drawing.Color]::FromArgb(212, 165, 116)
$bgColor    = [System.Drawing.Color]::FromArgb(255, 250, 243)

$baseDir = "d:\mycode\z code\apps\mobile\android\app\src\main\res"

# Splash sizes (Capacitor convention)
$splashSizes = @{
    "drawable"              = 480   # base
    "drawable-port-mdpi"    = 320
    "drawable-port-hdpi"    = 480
    "drawable-port-xhdpi"   = 720
    "drawable-port-xxhdpi"  = 960
    "drawable-port-xxxhdpi" = 1280
    "drawable-land-mdpi"    = 480
    "drawable-land-hdpi"    = 720
    "drawable-land-xhdpi"   = 960
    "drawable-land-xxhdpi"  = 1280
    "drawable-land-xxxhdpi" = 1920
}

function New-Splash([int]$w, [int]$h, [string]$outPath) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    $g.Clear($bgColor)

    # Z mark
    $fontSize = [int]([math]::Min($w, $h) * 0.35)
    $font = $null
    foreach ($ff in @("DM Serif Display", "Georgia", "Times New Roman")) {
        try {
            $f = New-Object System.Drawing.Font($ff, [single]$fontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
            $font = $f; break
        } catch { continue }
    }
    if ($font -eq $null) { $font = New-Object System.Drawing.Font("Arial", [single]$fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel) }

    $rectF = New-Object System.Drawing.RectangleF 0, ([single]($h * 0.25)), ([single]$w), ([single]($h * 0.5))
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rectF, $colorStart, $colorEnd,
        [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
    )
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center

    $g.DrawString("Z", $font, $brush, $rectF, $sf)
    $brush.Dispose()

    # "Ziner" wordmark below
    $wordFontSize = [int]([math]::Min($w, $h) * 0.08)
    $wordFont = $null
    foreach ($ff in @("DM Sans", "Segoe UI", "Arial")) {
        try {
            $f = New-Object System.Drawing.Font($ff, [single]$wordFontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
            $wordFont = $f; break
        } catch { continue }
    }
    if ($wordFont -eq $null) { $wordFont = New-Object System.Drawing.Font("Arial", [single]$wordFontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel) }

    $wordBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 60, 60, 60))
    $wordRect = New-Object System.Drawing.RectangleF 0, ([single]($h * 0.6)), ([single]$w), ([single]($h * 0.1))
    $g.DrawString("Ziner", $wordFont, $wordBrush, $wordRect, $sf)

    $g.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

foreach ($key in $splashSizes.Keys) {
    $size = $splashSizes[$key]
    $dir = Join-Path $baseDir $key
    if (-not (Test-Path $dir)) { continue }
    New-Splash $size $size (Join-Path $dir "splash.png")
    Write-Host "Splash: $key ($size x $size)" -ForegroundColor Green
}

Write-Host "All splash screens generated" -ForegroundColor Green
