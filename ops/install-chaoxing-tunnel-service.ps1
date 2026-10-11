$ErrorActionPreference = "Stop"

$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script as Administrator."
}

$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$config = Join-Path $PSScriptRoot "cloudflared-chaoxing.yml"
$serviceName = "ReshiChaoxingTunnel"

if (-not (Test-Path -LiteralPath $cloudflared) -or -not (Test-Path -LiteralPath $config)) {
  throw "The tunnel binary or configuration file is missing."
}

$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $service) {
  $commandLine = "`"$cloudflared`" --config `"$config`" tunnel run"
  New-Service -Name $serviceName `
    -DisplayName "Reshi Chaoxing Cloudflare Tunnel" `
    -BinaryPathName $commandLine `
    -StartupType Automatic `
    -Description "Connects the local Chaoxing relay to Cloudflare at boot." | Out-Null
} else {
  $existingCommand = (Get-CimInstance Win32_Service -Filter "Name = '$serviceName'").PathName
  if ($existingCommand -notlike "*$config*") {
    throw "A service with this name already exists with a different configuration."
  }
}

& sc.exe config $serviceName start= delayed-auto | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not configure automatic startup." }

& sc.exe failure $serviceName reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not configure automatic recovery." }

& sc.exe failureflag $serviceName 1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not enable recovery for non-crash failures." }

if ((Get-Service -Name $serviceName).Status -ne "Running") {
  Start-Service -Name $serviceName
}

Write-Output "Tunnel service installed and started: $serviceName"
