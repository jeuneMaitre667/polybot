# Bridge Connectivity Script: Local Dashboard -> Lightsail Bot
# Usage: .\bot-24-7\bridge-lightsail.ps1 -Ip "63.34.0.38"
# Ce script crée un tunnel SSH pour que le dashboard local puisse lire les données du bot distant.

param(
    [string]$Ip = "63.34.0.38",
    [string]$KeyPath = ""
)

$user = "ubuntu"
$remotePort = 3001
$localPort = 3001

Write-Host "`n=== Sniper Bridge: Dashboard <-> Lightsail ===" -ForegroundColor Cyan

# 1. Recherche de la clé SSH
if (-not $KeyPath) {
    $scriptKey = Join-Path $PSScriptRoot "LightsailDefaultKey-eu-west-1.pem"
    $parentKey = Join-Path (Split-Path $PSScriptRoot) "LightsailDefaultKey-eu-west-1.pem"
    $downloadsKey = Join-Path $env:USERPROFILE "Downloads\LightsailDefaultKey-eu-west-1.pem"

    if (Test-Path $scriptKey) { $KeyPath = $scriptKey }
    elseif (Test-Path $parentKey) { $KeyPath = $parentKey }
    elseif (Test-Path $downloadsKey) { $KeyPath = $downloadsKey }
    else {
        Write-Host "🚨 Erreur: Clé .pem non trouvée !" -ForegroundColor Red
        Write-Host "Veuillez spécifier le chemin: .\bridge-lightsail.ps1 -KeyPath 'C:\chemin\votre-cle.pem'"
        exit 1
    }
}

Write-Host "📍 Serveur: $Ip" -ForegroundColor Gray
Write-Host "🔑 Clé: $KeyPath" -ForegroundColor Gray
Write-Host "🔌 Tunnel: Local:$localPort -> Remote:$remotePort`n" -ForegroundColor Gray

Write-Host "Tentative de connexion... (Laissez cette fenêtre ouverte pour maintenir le dashboard Online)" -ForegroundColor Yellow

# Commande SSH pour le tunnel (Port Forwarding)
# -L [local_ip:]local_port:remote_ip:remote_port
& ssh -i "$KeyPath" -N -L "${localPort}:localhost:${remotePort}" "${user}@${Ip}" -o StrictHostKeyChecking=accept-new

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n❌ La connexion a échoué." -ForegroundColor Red
}
