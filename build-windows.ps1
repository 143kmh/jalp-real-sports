param([switch]$Portable)
$ErrorActionPreference = 'Stop'
$realAppRoot = $PSScriptRoot
$realCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $realCompiler)) { throw '.NET Framework 4.x compiler is required.' }
$realExe = Join-Path $realAppRoot 'Real Manager.exe'
& $realCompiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 /reference:System.Windows.Forms.dll "/out:$realExe" (Join-Path $realAppRoot 'Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
Write-Output "Built: $realExe"
if ($Portable) {
  $realNode = (Get-Command node.exe -ErrorAction Stop).Source
  & $realNode (Join-Path $realAppRoot 'package-windows.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Portable packaging failed.' }
}
