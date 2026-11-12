# Launch Granola through a proxy.
#
# Why: api.granola.ai and *.api.granola.ai return HTTP 451 (region block)
# for Russian IP addresses. Without a proxy the app hangs on the
# "Taking longer than usual" screen.
#
# Examples:
#   powershell -ExecutionPolicy Bypass -File scripts\granola-proxy.ps1 -Proxy http://127.0.0.1:10809
#   powershell -ExecutionPolicy Bypass -File scripts\granola-proxy.ps1 -Proxy socks5://127.0.0.1:1080
#   powershell -ExecutionPolicy Bypass -File scripts\granola-proxy.ps1 -Proxy http://user:pass@host:8080 -Restart
#
# Note: keep this file ASCII-only. Windows PowerShell 5.1 reads a file
# without BOM as ANSI and breaks on non-ASCII characters.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Proxy,

  [string]$NoProxy = 'localhost,127.0.0.1,::1',

  # Stop already running Granola processes before start.
  [switch]$Restart,

  # Only check the proxy, do not start the app.
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$exe = Join-Path $env:LOCALAPPDATA 'Programs\@granolaelectron\Granola.exe'
if (-not (Test-Path $exe)) {
  throw "Granola.exe not found: $exe"
}

if ($Proxy -notmatch '^[a-z0-9]+://') {
  $Proxy = 'http://' + $Proxy
}

Write-Output ("proxy: " + $Proxy)

# 1. Check that api.granola.ai answers through the proxy and is not 451.
try {
  $r = Invoke-WebRequest -Uri 'https://api.granola.ai/v1/health' -Proxy $Proxy -TimeoutSec 20 -UseBasicParsing
  Write-Output ("api.granola.ai via proxy => " + $r.StatusCode)
} catch {
  $resp = $_.Exception.Response
  if ($resp) {
    $code = [int]$resp.StatusCode
    Write-Output ("api.granola.ai via proxy => " + $code)
    if ($code -eq 451) {
      Write-Output 'WARNING: this proxy is also in a blocked region. Use a US/EU exit.'
    }
  } else {
    Write-Output ("api.granola.ai via proxy => error: " + $_.Exception.Message)
  }
}

if ($CheckOnly) { return }

# 2. Stop old processes.
if ($Restart) {
  $procs = Get-Process Granola -ErrorAction SilentlyContinue
  if ($procs) {
    Write-Output ("stopping Granola processes: " + $procs.Count)
    foreach ($p in $procs) { try { [void]$p.CloseMainWindow() } catch { } }
    Start-Sleep -Seconds 3
    Get-Process Granola -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
}

# 3. Environment variables. The Granola main process uses undici with
#    HTTPS_PROXY / HTTP_PROXY (ProxyAgent), see app.asar.
$env:HTTPS_PROXY = $Proxy
$env:HTTP_PROXY = $Proxy
$env:ALL_PROXY = $Proxy
$env:NO_PROXY = $NoProxy
$env:https_proxy = $Proxy
$env:http_proxy = $Proxy
$env:no_proxy = $NoProxy

# 4. Chromium switch for the renderer and the window network stack.
$bypass = ($NoProxy -split ',' | ForEach-Object { $_.Trim() }) -join ';'
$appArgs = @(
  "--proxy-server=$Proxy",
  "--proxy-bypass-list=$bypass"
)

Write-Output ("start: " + $exe + ' ' + ($appArgs -join ' '))
$proc = Start-Process -FilePath $exe -ArgumentList $appArgs -PassThru
Write-Output ("pid: " + $proc.Id)
Write-Output 'done. If no window appears, check the tray.'
