# File-Sync Bridge: Lightsail -> Local Mirror
# Usage: .\bot-24-7\sync-health.ps1
# Ce script synchronise les fichiers de statut du serveur vers votre PC toutes les 3 secondes.

param(
    [string]$Ip = "63.34.0.38",
    [string]$KeyPath = ""
)

$user = "ubuntu"
$remoteDir = "~/bot-24-7"
$localDir = $PSScriptRoot

Write-Host "`n=== Sniper Sync: Mirroring Lightsail Data === " -ForegroundColor Cyan

# 1. Recherche de la clé SSH
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
        Write-Host "🚨 Erreur: Clé SSH non trouvée !" -ForegroundColor Red
        exit 1
    }
}

Write-Host "📍 Serveur: $Ip" -ForegroundColor Gray
Write-Host "🔄 Intervalle: 3s" -ForegroundColor Gray
Write-Host "📂 Destination: $localDir`n" -ForegroundColor Gray

Write-Host "Synchronisation active. Laissez cette fenêtre ouverte." -ForegroundColor Yellow

while($true) {
    try {
        # Synchronisation des fichiers clés
        & scp -i "$KeyPath" -o StrictHostKeyChecking=accept-new -o LogLevel=QUIET "${user}@${Ip}:${remoteDir}/health.json" "$localDir/health.json"
        & scp -i "$KeyPath" -o StrictHostKeyChecking=accept-new -o LogLevel=QUIET "${user}@${Ip}:${remoteDir}/balance.json" "$localDir/balance.json"
        
        $now = Get-Date -Format "HH:mm:ss"
        Write-Host "[$now] ✅ Sync OK" -ForegroundColor Green
    }
    catch {
        Write-Host "[$now] ❌ Erreur de sync" -ForegroundColor Red
    }
    
    Start-Sleep -Seconds 3
}
