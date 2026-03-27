# Déploie le dossier bot-24-7 sur l'instance Lightsail via SCP puis exécute setup-remote.sh via SSH
# Usage: .\deploy-bot.ps1 -KeyPath "C:\Users\cedpa\Downloads\LightsailDefaultKey-eu-west-1.pem" -Ip "34.253.136.19"
# Ou sans paramètres : le script cherche la clé dans Downloads et te demande l'IP

param(
    [string]$KeyPath = "",
    [string]$Ip = ""
)

$ErrorActionPreference = "Stop"
$BotDir = Join-Path $PSScriptRoot "bot-24-7"

if (-not (Test-Path $BotDir)) {
    Write-Error "Dossier bot-24-7 introuvable dans $PSScriptRoot"
}

# Trouver la clé Lightsail si non fournie
if (-not $KeyPath) {
    $downloads = Join-Path $env:USERPROFILE "Downloads"
    $keys = Get-ChildItem -Path $downloads -Filter "*.pem" -ErrorAction SilentlyContinue
    $lightsailKey = $keys | Where-Object { $_.Name -like "*Lightsail*" -or $_.Name -like "*lightsail*" } | Select-Object -First 1
    if ($lightsailKey) {
        $KeyPath = $lightsailKey.FullName
        Write-Host "Clé trouvée : $KeyPath"
    } else {
        Write-Host "Aucune clé .pem Lightsail dans Téléchargements."
        $KeyPath = Read-Host "Chemin complet du fichier .pem (ex: C:\Users\cedpa\Downloads\LightsailDefaultKey-eu-west-1.pem)"
    }
}

if (-not (Test-Path $KeyPath)) {
    Write-Error "Fichier clé introuvable : $KeyPath"
}

if (-not $Ip) {
    $Ip = Read-Host "IPv4 publique de l'instance Lightsail (ex: 34.253.136.19)"
}

$user = "ubuntu"
$remoteDir = "~/bot-24-7"

Write-Host "`n=== Envoi du dossier bot-24-7 vers $user@${Ip}:$remoteDir ===" -ForegroundColor Cyan
& scp -i $KeyPath -o StrictHostKeyChecking=accept-new -r $BotDir "${user}@${Ip}:~/"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`n=== Exécution du setup sur le serveur ===" -ForegroundColor Cyan
& ssh -i $KeyPath "${user}@${Ip}" "chmod +x ~/bot-24-7/setup-remote.sh && ~/bot-24-7/setup-remote.sh"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`n=== Lancement du bot avec PM2 (24/7) ===" -ForegroundColor Cyan
& ssh -i $KeyPath "${user}@${Ip}" "chmod +x ~/bot-24-7/start-pm2.sh && ~/bot-24-7/start-pm2.sh"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`n=== Déploiement terminé ===" -ForegroundColor Green
Write-Host "Le bot tourne en arrière-plan (sans wallet pour l'instant)."
Write-Host "Quand tu veux connecter ton wallet Polymarket :"
Write-Host "  1. ssh -i `"$KeyPath`" ${user}@${Ip}"
Write-Host "  2. nano ~/bot-24-7/.env   (remplace PRIVATE_KEY par ta clé)"
Write-Host "  3. pm2 restart polymarket-bot"
Write-Host "Logs : pm2 logs polymarket-bot"
