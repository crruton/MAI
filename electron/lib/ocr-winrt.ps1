# Text recognition with the built-in Windows engine (Windows.Media.Ocr).
#
# Why: Windows 10/11 ships an OCR engine and language packs. It needs no model
# download and works offline. Called from electron/lib/ocr.js.
#
# This file is ASCII only on purpose. Windows PowerShell 5.1 reads a script
# without a BOM as ANSI, so Cyrillic comments break the parser. User-facing
# messages are built in ocr.js from the `code` field.
#
# The result is written to a UTF-8 file: the PowerShell 5.1 console uses the OEM
# code page and Cyrillic text in stdout is corrupted.
#
# Examples:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ocr-winrt.ps1 -ListLanguages
#   powershell -NoProfile -ExecutionPolicy Bypass -File ocr-winrt.ps1 `
#     -Path image.png -OutFile out.json -Language ru

param(
  [string]$Path = '',
  [string]$OutFile = '',
  [string]$Language = 'ru',
  [int]$MaxDimension = 4000,
  [double]$Scale = 1.0,
  [switch]$ListLanguages
)

$ErrorActionPreference = 'Stop'

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  if ($OutFile) {
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  } else {
    [Console]::Out.Write($json)
  }
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  # Bridge from WinRT IAsyncOperation to .NET Task: PowerShell 5.1 has no await.
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

  function Await($operation, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($operation))
    if (-not $task.Wait(120000)) { throw 'WinRT operation did not finish in 120 s' }
    $task.Result
  }

  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

  $available = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })

  if ($ListLanguages) {
    Write-Result ([pscustomobject]@{
        ok           = $true
        engine       = 'windows-media-ocr'
        languages    = $available
        maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
      })
    exit 0
  }

  if (-not $Path) { throw 'Path is required' }

  $full = (Resolve-Path -LiteralPath $Path).ProviderPath
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])

  # The engine rejects images larger than MaxImageDimension: shrink on decode.
  $width = [int]$decoder.PixelWidth
  $height = [int]$decoder.PixelHeight
  $scale = 1.0
  $limit = [Math]::Min($MaxDimension, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension)
  if ($width -gt $limit -or $height -gt $limit) {
    $scale = [Math]::Min($limit / $width, $limit / $height)
  }
  # Small UI text sometimes reads better after upscaling. Measured on a 1023x636
  # screenshot: scale 2.0 gave the same text, so the default stays 1.0.
  if ($Scale -gt 1.0) {
    $scale = [Math]::Min($Scale, $limit / [Math]::Max($width, $height))
  }

  if ($scale -ne 1.0) {
    $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
    $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Round($width * $scale))
    $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Round($height * $scale))
    $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
        $transform,
        [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
      )) ([Windows.Graphics.Imaging.SoftwareBitmap])
  } else {
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  }

  # Language: requested first, then the user profile, then any available one.
  $engine = $null
  $usedLanguage = ''
  if ($Language) {
    try {
      $lang = New-Object Windows.Globalization.Language($Language)
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
      if ($engine) { $usedLanguage = $lang.LanguageTag }
    } catch {
      $engine = $null
    }
  }
  if (-not $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($engine) { $usedLanguage = $engine.RecognizerLanguage.LanguageTag }
  }
  if (-not $engine) {
    Write-Result ([pscustomobject]@{
        ok        = $false
        code      = 'no-engine'
        languages = $available
        error     = "no OCR engine for language '$Language'"
      })
    exit 2
  }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $lines = @()
  foreach ($line in $result.Lines) {
    $words = @($line.Words)
    $x = 0.0; $y = 0.0; $w = 0.0; $h = 0.0
    if ($words.Count -gt 0) {
      # Measure-Object in PowerShell 5.1 does not accept a scriptblock in
      # -Property, so the bounds are computed in a loop.
      $x = [double]::MaxValue; $y = [double]::MaxValue
      $right = [double]::MinValue; $bottom = [double]::MinValue
      foreach ($word in $words) {
        $rect = $word.BoundingRect
        if ($rect.X -lt $x) { $x = $rect.X }
        if ($rect.Y -lt $y) { $y = $rect.Y }
        if (($rect.X + $rect.Width) -gt $right) { $right = $rect.X + $rect.Width }
        if (($rect.Y + $rect.Height) -gt $bottom) { $bottom = $rect.Y + $rect.Height }
      }
      $w = $right - $x
      $h = $bottom - $y
    }
    $lines += [pscustomobject]@{
      text   = $line.Text
      x      = [Math]::Round($x / $scale, 1)
      y      = [Math]::Round($y / $scale, 1)
      width  = [Math]::Round($w / $scale, 1)
      height = [Math]::Round($h / $scale, 1)
    }
  }

  Write-Result ([pscustomobject]@{
      ok       = $true
      engine   = 'windows-media-ocr'
      language = $usedLanguage
      width    = $width
      height   = $height
      scaled   = ($scale -ne 1.0)
      lines    = $lines
      text     = (($lines | ForEach-Object { $_.text }) -join "`n")
    })
} catch {
  Write-Result ([pscustomobject]@{
      ok    = $false
      code  = 'failed'
      error = $_.Exception.Message
    })
  exit 1
}
