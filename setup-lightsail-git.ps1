# Configure le bot sur Lightsail pour le redéploiement depuis GitHub (GIT_REPO_URL + redeploy.sh)
# Usage: .\setup-lightsail-git.ps1
# Ou: .\setup-lightsail-git.ps1 -KeyPath "chemin\vers\cle.pem" -Ip "18.203.159.101"
# Prérequis: le bot a déjà été déployé au moins une fois (.\deploy-bot.ps1) pour que redeploy.sh existe.

param(
    [string]$KeyPath = "",
    [string]$Ip = ""
)

$ErrorActionPreference = "Stop"
$GIT_REPO_URL = "https://github.com/jeuneMaitre667/polybot.git"
$user = "ubuntu"

# Réutiliser la même logique que deploy-bot.ps1 pour clé et IP
if (-not $KeyPath) {
    $scriptKey = Join-Path $PSScriptRoot "LightsailDefaultKey-eu-west-1.pem"
    if (Test-Path $scriptKey) { $KeyPath = $scriptKey }
    else {
        $downloads = Join-Path $env:USERPROFILE "Downloads"
        $keys = Get-ChildItem -Path $downloads -Filter "*.pem" -ErrorAction SilentlyContinue
        $lightsailKey = $keys | Where-Object { $_.Name -like "*Lightsail*" -or $_.Name -like "*lightsail*" } | Select-Object -First 1
        if ($lightsailKey) { $KeyPath = $lightsailKey.FullName }
    }
    if (-not $KeyPath) {
        Write-Host "Aucune clé .pem trouvée."
        $KeyPath = Read-Host "Chemin complet du fichier .pem"
    }
}
if (-not (Test-Path $KeyPath)) { Write-Error "Fichier clé introuvable : $KeyPath" }

if (-not $Ip) {
    $Ip = Read-Host "IPv4 publique de l'instance Lightsail (ex: 18.203.159.101)"
}

# Une seule ligne pour éviter les problèmes d'échappement SSH
$remoteCmd = "cd ~/bot-24-7 && ([ -f .env ] || cp .env.example .env) && (grep -q 'GIT_REPO_URL=' .env || echo 'GIT_REPO_URL=$GIT_REPO_URL' >> .env) && chmod +x redeploy.sh 2>/dev/null; if [ -f redeploy.sh ]; then ./redeploy.sh; else echo 'ERREUR: redeploy.sh introuvable. Lance d abord deploy-bot.ps1'; exit 1; fi"

Write-Host "`n=== Configuration Git + redéploiement sur Lightsail ===" -ForegroundColor Cyan
Write-Host "   Serveur: $user@${Ip}" -ForegroundColor Gray
Write-Host "   Repo: $GIT_REPO_URL`n" -ForegroundColor Gray

& ssh -i $KeyPath -o StrictHostKeyChecking=accept-new "${user}@${Ip}" $remoteCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`n=== Terminé ===" -ForegroundColor Green
Write-Host "Pour les prochaines mises à jour: git push puis sur le serveur: ~/bot-24-7/redeploy.sh"
