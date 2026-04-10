# Robust Connectivity Bridge: Local Dashboard -> Lightsail Bot (Final Fix)
# Ce script assure une liaison 100% stable via un tunnel SSH.

param(
    [string]$Ip = "63.34.0.38",
    [string]$KeyPath = ""
)

$user = "ubuntu"
$remotePort = 3001
$localPort = 3001

Write-Host "=== Sniper Tunnel: Stable Connection Management ===" -ForegroundColor Cyan

# 1. Recherche de la cle SSH (Lightsail)
if (-not $KeyPath) {
    $scriptKey = Join-Path $PSScriptRoot "LightsailDefaultKey-eu-west-1.pem"
    $parentKey = Join-Path (Split-Path $PSScriptRoot) "LightsailDefaultKey-eu-west-1.pem"
    $keysDir = Join-Path (Split-Path $PSScriptRoot) "lightsail-keys\clé 2gb ram bot15m.pem"
    $downloadsKey = Join-Path $env:USERPROFILE "Downloads\LightsailDefaultKey-eu-west-1.pem"

    if (Test-Path $scriptKey) { $KeyPath = $scriptKey }
    elseif (Test-Path $parentKey) { $KeyPath = $parentKey }
    elseif (Test-Path $keysDir) { $KeyPath = $keysDir }
    elseif (Test-Path $downloadsKey) { $KeyPath = $downloadsKey }
    else {
        Write-Host "ERREUR: Cle Lightsail introuvable !" -ForegroundColor Red
        exit 1
    }
}

Write-Host "Serveur: $Ip" -ForegroundColor Gray
Write-Host "Cle: $KeyPath" -ForegroundColor Gray
Write-Host "Tunnel: Local:$localPort -> Remote:$remotePort" -ForegroundColor Gray

while($true) {
    Write-Host "Connecting to Sniper Console data feed..." -ForegroundColor Yellow
    
    # -N : Ne pas executer de commande distante
    # -L : Port Forwarding
    # -o ConnectTimeout : Pour echouer vite si le reseau saute
    & ssh -i "$KeyPath" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -N -L "${localPort}:localhost:${remotePort}" "${user}@${Ip}"
    
    Write-Host "Connexion coupee. Reconnexion dans 3 secondes..." -ForegroundColor DarkYellow
    Start-Sleep -Seconds 3
}
