$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await-WinRt($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}

$ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$results = @()

foreach ($imgPath in $args) {
  $item = [ordered]@{
    path = $imgPath
    width = 0
    height = 0
    ocrText = ''
    darkRatio = 0
    lightRatio = 0
    skinRatio = 0
    bubbleTransitions = 0
  }

  if (-not $imgPath -or -not (Test-Path -LiteralPath $imgPath)) {
    $results += [pscustomobject]$item
    continue
  }

  try {
    $bmp = [System.Drawing.Bitmap]::FromFile($imgPath)
    $w = [int]$bmp.Width
    $h = [int]$bmp.Height
    $item.width = $w
    $item.height = $h

    $grid = 24
    $totalPx = 0
    $darkPx = 0
    $lightPx = 0
    $skinPx = 0
    $rowLums = @()

    for ($ry = 0; $ry -lt $grid; $ry++) {
      $py = [Math]::Min($h - 1, [Math]::Max(0, [int](($ry + 0.5) * $h / $grid)))
      $rowSum = 0.0
      $rowCnt = 0
      for ($rx = 0; $rx -lt $grid; $rx++) {
        $px = [Math]::Min($w - 1, [Math]::Max(0, [int](($rx + 0.5) * $w / $grid)))
        $c = $bmp.GetPixel($px, $py)
        $r = [int]$c.R; $g = [int]$c.G; $b = [int]$c.B
        $lum = 0.299 * $r + 0.587 * $g + 0.114 * $b
        $totalPx++
        if ($lum -lt 55) { $darkPx++ }
        if ($lum -gt 215) { $lightPx++ }
        $maxRgb = [Math]::Max($r, [Math]::Max($g, $b))
        $minRgb = [Math]::Min($r, [Math]::Min($g, $b))
        if ($r -gt 95 -and $g -gt 40 -and $b -gt 20 -and ($maxRgb - $minRgb) -gt 15 -and [Math]::Abs($r - $g) -gt 15 -and $r -gt $g -and $r -gt $b) {
          $skinPx++
        }
        if ($rx -ge 5 -and $rx -le 18) {
          $rowSum += $lum
          $rowCnt++
        }
      }
      if ($rowCnt -gt 0) {
        $rowLums += ($rowSum / $rowCnt)
      }
    }

    if ($totalPx -gt 0) {
      $item.darkRatio = [Math]::Round($darkPx / $totalPx, 3)
      $item.lightRatio = [Math]::Round($lightPx / $totalPx, 3)
      $item.skinRatio = [Math]::Round($skinPx / $totalPx, 3)
    }

    $transitions = 0
    for ($i = 1; $i -lt $rowLums.Count; $i++) {
      if ([Math]::Abs($rowLums[$i] - $rowLums[$i - 1]) -ge 28) {
        $transitions++
      }
    }
    $item.bubbleTransitions = $transitions
    $bmp.Dispose()
  } catch {
    if ($bmp) { $bmp.Dispose() }
  }

  try {
    if ($ocrEngine -ne $null) {
      $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imgPath)) ([Windows.Storage.StorageFile])
      $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
      $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $softBmp = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $ocrRes = Await-WinRt ($ocrEngine.RecognizeAsync($softBmp)) ([Windows.Media.Ocr.OcrResult])
      if ($ocrRes -and $ocrRes.Text) {
        $item.ocrText = [string]$ocrRes.Text
      }
      if ($softBmp) { $softBmp.Dispose() }
      if ($stream) { $stream.Dispose() }
    }
  } catch {
    if ($stream) { $stream.Dispose() }
  }

  $results += [pscustomobject]$item
}

$payload = @{ ok = $true; items = @($results) }
Write-Output ($payload | ConvertTo-Json -Depth 4 -Compress)
