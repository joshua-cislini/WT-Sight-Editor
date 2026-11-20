param(
  [switch]$Watch,
  [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = (Get-Location).Path }
$sightsDir = Join-Path $rootDir "sights"

if (-not (Test-Path $sightsDir)) {
  New-Item -ItemType Directory -Path $sightsDir -Force | Out-Null
}

$defaultSight = @"
crosshairHorVertSize:p2=3, 2
rangefinderProgressBarColor1:c=0, 255, 0, 64
rangefinderProgressBarColor2:c=255, 255, 255, 64
rangefinderTextScale:r=0.7
rangefinderUseThousandth:b=no
rangefinderVerticalOffset:r=0.1
rangefinderHorizontalOffset:r=5
detectAllyTextScale:r=0.7
detectAllyOffset:p2=4, 0.05
fontSizeMult:r=1
lineSizeMult:r=1
drawCentralLineVert:b=yes
drawCentralLineHorz:b=yes
drawSightMask:b=yes
useSmoothEdge:b=yes
crosshairColor:c=0, 0, 0, 255
crosshairLightColor:c=255, 64, 64, 255
crosshairDistHorSizeMain:p2=0.03, 0.02
crosshairDistHorSizeAdditional:p2=0.005, 0.003
distanceCorrectionPos:p2=-0.26, -0.05
drawDistanceCorrection:b=yes

crosshair_distances{
  distance:p3=200, 0, 0
  distance:p3=400, 4, 0
  distance:p3=600, 0, 0
  distance:p3=800, 8, 0
  distance:p3=1000, 0, 0
  distance:p3=1200, 12, 0
  distance:p3=1400, 0, 0
  distance:p3=1600, 16, 0
  distance:p3=1800, 0, 0
  distance:p3=2000, 20, 0
}

crosshair_hor_ranges{
  range:p2=-32, 32
  range:p2=-28, 0
  range:p2=-24, 24
  range:p2=-20, 0
  range:p2=-16, 16
  range:p2=-12, 0
  range:p2=-8, 8
  range:p2=-4, 0
  range:p2=4, 0
  range:p2=8, 8
  range:p2=12, 0
  range:p2=16, 16
  range:p2=20, 0
  range:p2=24, 24
  range:p2=28, 0
  range:p2=32, 32
}

matchExpClass{
  exp_tank:b = yes
  exp_heavy_tank:b = yes
  exp_tank_destroyer:b = yes
  exp_SPAA:b = yes
}

drawLines{

}
"@

function Update-PresetsJs {
  $files = @(Get-ChildItem -Path $sightsDir -Filter "*.blk" -File -Recurse -ErrorAction SilentlyContinue | Sort-Object {
    if ($_.BaseName -match '^\d+$') { [int]$_.BaseName } else { 999999 }
  }, Name)

  $presets = [ordered]@{}
  $meta = [ordered]@{}

  foreach ($f in $files) {
    $relName = $f.Name
    if ($f.DirectoryName -ne $sightsDir) {
      $sub = $f.FullName.Substring($sightsDir.Length + 1).Replace('\', '/')
      $relName = $sub
    }
    $raw = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
    $presets[$relName] = $raw
    $meta[$relName] = @{
      name = $relName
      path = "sights/$relName"
      size = $f.Length
      mtime = $f.LastWriteTimeUtc.ToString("o")
    }
  }

  $presets["Default Sight"] = $defaultSight
  $meta["Default Sight"] = @{
    name = "Default Sight"
    path = "builtin/Default Sight"
    size = $defaultSight.Length
    mtime = "builtin"
  }

  $jsonPresets = $presets | ConvertTo-Json -Depth 2 -Compress
  $jsonMeta = $meta | ConvertTo-Json -Depth 3 -Compress
  $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  $content = "// Auto-generated from sights/ folder ($($files.Count) sights found)`n" +
             "window.WT_PRESETS_STAMP = $stamp;`n" +
             "window.WT_PRESETS_META = $jsonMeta;`n" +
             "window.WT_PRESETS = $jsonPresets;`n"

  $targetPath = Join-Path $rootDir "presets.js"
  [System.IO.File]::WriteAllText($targetPath, $content, [System.Text.UTF8Encoding]::new($false))
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Synced $($files.Count) sight(s) from sights/ -> presets.js"
}

Update-PresetsJs

if ($OpenBrowser) {
  $indexHtml = Join-Path $rootDir "index.html"
  Start-Process $indexHtml
}

if ($Watch) {
  Write-Host "Watching '$sightsDir' for changes... (Keep this window open or minimize it)"
  $lastSig = ""
  while ($true) {
    $files = @(Get-ChildItem -Path $sightsDir -Filter "*.blk" -File -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName)
    $sigParts = foreach ($f in $files) { "$($f.FullName)|$($f.Length)|$($f.LastWriteTimeUtc.Ticks)" }
    $sig = $sigParts -join ";"
    if ($sig -ne $lastSig) {
      if ($lastSig -ne "") {
        Start-Sleep -Milliseconds 150
        Update-PresetsJs
      }
      $lastSig = $sig
    }
    Start-Sleep -Milliseconds 1000
  }
}
