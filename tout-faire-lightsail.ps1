# Execute toutes les etapes : deploiement du bot sur Lightsail + config Git + redeploy depuis GitHub.
# Aucune question si la cle .pem est trouvee et que -Ip est fourni (ou utilise la valeur par defaut).
#
# Usage:
#   .\tout-faire-lightsail.ps1
#   .\tout-faire-lightsail.ps1 -KeyPath "C:\Users\cedpa\Downloads\LightsailDefaultKey-eu-west-1.pem" -Ip "108.130.195.85"

param(
    [string]$KeyPath = "",
    [string]$Ip = "108.130.195.85"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# Trouver la cle .pem si non fournie
if (-not $KeyPath) {
    $inProject = Join-Path $root "LightsailDefaultKey-eu-west-1.pem"
    $inDownloads = Join-Path $env:USERPROFILE "Downloads\LightsailDefaultKey-eu-west-1.pem"
    if (Test-Path $inProject) { $KeyPath = $inProject }
    elseif (Test-Path $inDownloads) { $KeyPath = $inDownloads }
    else {
        $downloads = Join-Path $env:USERPROFILE "Downloads"
        if (Test-Path $downloads) {
            $anyPem = Get-ChildItem -Path $downloads -Filter "*.pem" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($anyPem) { $KeyPath = $anyPem.FullName }
        }
    }
}

if (-not $KeyPath -or -not (Test-Path $KeyPath)) {
    Write-Host ""
    Write-Host "Cle .pem introuvable." -ForegroundColor Yellow
    Write-Host "  Copie ta cle Lightsail dans le projet et nomme-la: LightsailDefaultKey-eu-west-1.pem" -ForegroundColor Gray
    Write-Host "  Ou lance: .\tout-faire-lightsail.ps1 -KeyPath `"C:\chemin\vers\ta-cle.pem`" -Ip `"108.130.195.85`"" -ForegroundColor Gray
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "========== Deploiement + config Git sur Lightsail ==========" -ForegroundColor Cyan
Write-Host "  Cle: $KeyPath" -ForegroundColor Gray
Write-Host "  IP:  $Ip" -ForegroundColor Gray
Write-Host ""

# 1) Deploiement complet (on continue meme si pm2 startup demande une commande a taper)
Write-Host ">>> Etape 1/2 : Envoi du bot et setup (SCP + npm + PM2)..." -ForegroundColor Cyan
& "$root\deploy-bot.ps1" -KeyPath $KeyPath -Ip $Ip
$step1Ok = ($LASTEXITCODE -eq 0)
if (-not $step1Ok) { Write-Host "  (Etape 1 : attention code sortie $LASTEXITCODE, on continue.)" -ForegroundColor Gray }

# 2) Config Git + redeploy depuis GitHub (si repo public ; sinon le clone echouera)
Write-Host ""
Write-Host ">>> Etape 2/2 : Config GIT_REPO_URL + redeploy depuis GitHub..." -ForegroundColor Cyan
& "$root\setup-lightsail-git.ps1" -KeyPath $KeyPath -Ip $Ip
if ($LASTEXITCODE -ne 0) {
    Write-Host "  (Etape 2 : redeploy depuis GitHub a echoue. Normal si le repo est prive.)" -ForegroundColor Gray
    Write-Host "  Pour mettre a jour le bot : relance ce script depuis ton PC apres un git pull." -ForegroundColor Gray
}

Write-Host ""
Write-Host "========== Tout est termine ==========" -ForegroundColor Green
Write-Host "  Pense a verifier que PRIVATE_KEY est dans ~/bot-24-7/.env sur le serveur." -ForegroundColor Gray
Write-Host "  Pour mettre a jour le bot plus tard : sur ton PC fait git pull puis relance ce script." -ForegroundColor Gray
Write-Host "  (Si le repo GitHub est public, tu peux aussi utiliser ~/bot-24-7/redeploy.sh sur le serveur.)" -ForegroundColor Gray
Write-Host ""
