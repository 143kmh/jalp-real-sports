param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$realLauncher = Join-Path $PSScriptRoot 'Real Manager.exe'
if (Test-Path -LiteralPath $realLauncher) {
  if ($NoBrowser) { $realLaunchProcess = Start-Process -FilePath $realLauncher -ArgumentList '--no-ui' -WindowStyle Hidden -Wait -PassThru }
  else { $realLaunchProcess = Start-Process -FilePath $realLauncher -Wait -PassThru }
  if ($realLaunchProcess.ExitCode -ne 0) { throw 'Launcher failed. See data\launcher-error.log.' }
  return
}
$nodePath = Join-Path $PSScriptRoot 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $nodePath) { throw 'Node.js 22.12+ is required. Install from nodejs.org.' }
$appDirectory = $PSScriptRoot
New-Item -ItemType Directory -Path (Join-Path $appDirectory 'data') -Force | Out-Null
$running = $false
try {
  $response = Invoke-WebRequest 'http://127.0.0.1:5127/' -UseBasicParsing -TimeoutSec 2
  $running = $response.Content -match '<title>Real Manager</title>'
} catch {}
if (-not $running) {
  $serverPath = Join-Path $appDirectory 'server.mjs'
  Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $appDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $appDirectory 'data\startup.log') -RedirectStandardError (Join-Path $appDirectory 'data\startup-error.log')
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
      $response = Invoke-WebRequest 'http://127.0.0.1:5127/' -UseBasicParsing -TimeoutSec 1
      if ($response.Content -match '<title>Real Manager</title>') { $running = $true; break }
    } catch {}
  }
}
if (-not $running) { throw 'Panel did not start. See data\startup-error.log.' }
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5127/' }
