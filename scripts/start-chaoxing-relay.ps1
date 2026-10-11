$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $workspace "work"
$relayScript = Join-Path $PSScriptRoot "chaoxing-local-relay.mjs"
$tunnelConfig = Join-Path $workspace "ops\cloudflared-chaoxing.yml"
$nodePath = "C:\Program Files\nodejs\node.exe"
$cloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Test-ConfiguredTunnelRunning {
  $tunnels = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue
  if ($tunnels | Where-Object { $_.CommandLine -like "*$tunnelConfig*" }) {
    return $true
  }

  # Avoid launching a duplicate if process command lines cannot be inspected.
  if (-not $tunnels -and (Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue)) {
    return $true
  }

  return $false
}

# The logon task stays alive so a DNS outage during sign-in, or a later
# cloudflared exit, cannot leave the relay disconnected until the next logon.
while ($true) {
  $relayListening = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue
  if (-not $relayListening) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Start-Process -FilePath $nodePath `
      -ArgumentList @($relayScript) `
      -WorkingDirectory $workspace `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logDirectory "chaoxing-relay-$stamp.log") `
      -RedirectStandardError (Join-Path $logDirectory "chaoxing-relay-$stamp-error.log") | Out-Null
  }

  $tunnelService = Get-Service -Name "ReshiChaoxingTunnel" -ErrorAction SilentlyContinue
  if (-not $tunnelService -and -not (Test-ConfiguredTunnelRunning)) {
    $dnsReady = $false
    try {
      $dnsReady = [bool](Resolve-DnsName -Name "_v2-origintunneld._tcp.argotunnel.com" -Type SRV -ErrorAction Stop |
        Where-Object { $_.NameTarget })
    } catch {
      # The network adapter may not have DNS servers yet at logon.
    }

    if ($dnsReady) {
      $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
      Start-Process -FilePath $cloudflaredPath `
        -ArgumentList @("tunnel", "--config", $tunnelConfig, "run") `
        -WorkingDirectory $workspace `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDirectory "chaoxing-relay-tunnel-$stamp.log") `
        -RedirectStandardError (Join-Path $logDirectory "chaoxing-relay-tunnel-$stamp-error.log") | Out-Null
    }
  }

  Start-Sleep -Seconds 30
}
