Add-Type -AssemblyName System.Drawing

# Ziner brand colors (matching desktop Warm Minimal Light Theme)
$colorStart = [System.Drawing.Color]::FromArgb(91, 122, 158)     # var(--accent) - #5b7a9e
$colorEnd   = [System.Drawing.Color]::FromArgb(201, 122, 90)     # var(--accent-warm) - #c97a5a
$bgColor    = [System.Drawing.Color]::FromArgb(250, 248, 245)    # var(--bg) - #faf8f5

# Sizes for mipmap densities (foreground; for legacy mipmap-* we add bg)
$sizes = @{
    "mdpi"    = 48
    "hdpi"    = 72
    "xhdpi"   = 96
    "xxhdpi"  = 144
    "xxxhdpi" = 192
}

$baseDir = "d:\mycode\z code\apps\mobile\android\app\src\main\res"

# Background drawable (color resource used by adaptive icon)
$bgXml = @"
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#FF5B7A9E</color>
</resources>
"@
$bgPath = Join-Path $baseDir "values\ic_launcher_background.xml"
[System.IO.File]::WriteAllText($bgPath, $bgXml, [System.Text.Encoding]::UTF8)
Write-Host "Background color set" -ForegroundColor Green

# Adaptive icon foreground (108x108dp with safe zone 72x72dp center)
# Generate as 432x432 PNG (xxhdpi * 3); for other densities we'll scale
function New-ZinerForeground([int]$size, [string]$outPath) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # Transparent background
    $g.Clear([System.Drawing.Color]::Transparent)

    # Use DM Serif Display if available, else fall back
    $fontFamilies = @("DM Serif Display", "Georgia", "Times New Roman")
    $font = $null
    foreach ($ff in $fontFamilies) {
        try {
            $f = New-Object System.Drawing.Font($ff, [single]($size * 0.78), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
            if ($f.Name -eq $ff -or $ff -eq "Georgia") { $font = $f; break }
        } catch { continue }
    }
    if ($font -eq $null) { $font = New-Object System.Drawing.Font("Arial", [single]($size * 0.78), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel) }

    # Draw "Z" with gradient brush
    $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect, $colorStart, $colorEnd,
        [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
    )

    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center

    $g.DrawString("Z", $font, $brush, $rect, $sf)

    $g.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

# Round (legacy) icon: same Z on warm-white circle background
function New-ZinerRound([int]$size, [string]$outPath) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # Circle background with subtle gradient
    $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect, $colorStart, $colorEnd,
        [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
    )
    $g.FillEllipse($bgBrush, $rect)
    $bgBrush.Dispose()

    # Z letter in white
    $fontFamilies = @("DM Serif Display", "Georgia", "Times New Roman")
    $font = $null
    foreach ($ff in $fontFamilies) {
        try {
            $f = New-Object System.Drawing.Font($ff, [single]($size * 0.68), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
            $font = $f; break
        } catch { continue }
    }
    if ($font -eq $null) { $font = New-Object System.Drawing.Font("Arial", [single]($size * 0.68), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel) }

    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center

    $whiteBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $rectF = New-Object System.Drawing.RectangleF 0, 0, $size, $size
    $g.DrawString("Z", $font, $whiteBrush, $rectF, $sf)

    $g.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

# Legacy (square) icon: Z on warm-white rounded square
function New-ZinerSquare([int]$size, [string]$outPath) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # Warm-white rounded square background
    $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $radius = [int]($size * 0.18)
    $bgPath.AddArc(0, 0, $radius, $radius, 180, 90)
    $bgPath.AddArc($size - $radius, 0, $radius, $radius, 270, 90)
    $bgPath.AddArc($size - $radius, $size - $radius, $radius, $radius, 0, 90)
    $bgPath.AddArc(0, $size - $radius, $radius, $radius, 90, 90)
    $bgPath.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush $bgColor), $bgPath)

    # Subtle border
    $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(40, 74, 106, 142)), ([single]($size * 0.015))
    $g.DrawPath($borderPen, $bgPath)
    $borderPen.Dispose()

    # Z with gradient
    $rectF = New-Object System.Drawing.RectangleF 0, 0, $size, $size
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rectF, $colorStart, $colorEnd,
        [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
    )

    $fontFamilies = @("DM Serif Display", "Georgia", "Times New Roman")
    $font = $null
    foreach ($ff in $fontFamilies) {
        try {
            $f = New-Object System.Drawing.Font($ff, [single]($size * 0.7), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
            $font = $f; break
        } catch { continue }
    }
    if ($font -eq $null) { $font = New-Object System.Drawing.Font("Arial", [single]($size * 0.7), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel) }

    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center

    $g.DrawString("Z", $font, $brush, $rectF, $sf)

    $g.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

# Generate icons for all densities
foreach ($key in $sizes.Keys) {
    $size = $sizes[$key]
    $dir = Join-Path $baseDir "mipmap-$key"
    if (-not (Test-Path $dir)) { continue }

    # Adaptive icon foreground (108dp = $size*108/$size effectively, but for older mipmaps we use 72dp-equivalent square PNGs)
    # The mipmap-* folders use the size as the legacy icon size; foreground is independent
    $fgSize = [int]($size * 1.5)  # 1.5x for foreground (standard ratio)
    New-ZinerForeground $fgSize (Join-Path $dir "ic_launcher_foreground.png")
    New-ZinerRound $size (Join-Path $dir "ic_launcher_round.png")
    New-ZinerSquare $size (Join-Path $dir "ic_launcher.png")
    Write-Host "Generated icons for $key (square=$size, foreground=$fgSize)" -ForegroundColor Green
}

# Also generate v24 adaptive icon XML (foreground on color background)
$v24Fg = @"
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#5B7A9E"
        android:pathData="M0,0h108v108h-108z" />
    <path
        android:fillColor="#C97A5A"
        android:pathData="M0,0L108,0L108,108L0,108Z" />
</vector>
"@
# Simpler: just keep the PNG version
Write-Host "Done." -ForegroundColor Green
