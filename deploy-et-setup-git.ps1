# Déploie le bot sur Lightsail PUIS configure Git et lance le redéploiement depuis GitHub (tout-en-un).
# Usage: .\deploy-et-setup-git.ps1
# Utilise la même clé et IP que deploy-bot.ps1.

param(
    [string]$KeyPath = "",
    [string]$Ip = ""
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# 1) Déploiement complet (envoi du dossier + setup + PM2)
Write-Host "`n========== Étape 1/2 : Déploiement du bot (SCP + setup + PM2) ==========" -ForegroundColor Cyan
& "$root\deploy-bot.ps1" -KeyPath $KeyPath -Ip $Ip
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 2) Configuration Git + redeploy depuis GitHub
Write-Host "`n========== Étape 2/2 : Configuration Git et redéploiement depuis GitHub ==========" -ForegroundColor Cyan
& "$root\setup-lightsail-git.ps1" -KeyPath $KeyPath -Ip $Ip
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`n========== Tout est prêt ==========" -ForegroundColor Green
Write-Host "  - Bot déployé et configuré avec GIT_REPO_URL"
Write-Host "  - Prochaines mises à jour: git push puis sur le serveur: ~/bot-24-7/redeploy.sh"
Write-Host "  - Pense à mettre ta PRIVATE_KEY dans ~/bot-24-7/.env sur le serveur si ce n'est pas déjà fait."
