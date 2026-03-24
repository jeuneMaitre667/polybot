# Configure les secrets GitHub (LIGHTSAIL_SSH_KEY, LIGHTSAIL_HOST) pour l'Action de redéploiement.
# Prérequis : GitHub CLI installé et connecte (winget install GitHub.cli ou https://cli.github.com/)
# Usage: .\setup-github-secrets.ps1
# Ou:   .\setup-github-secrets.ps1 -KeyPath "C:\chemin\vers\cle.pem" -HostIp "18.203.159.101"

param(
    [string]$KeyPath = "",
    [string]$HostIp = "18.203.159.101"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

if (-not $KeyPath) {
    $inProject = Join-Path $root "LightsailDefaultKey-eu-west-1.pem"
    $inDownloads = Join-Path $env:USERPROFILE "Downloads\LightsailDefaultKey-eu-west-1.pem"
    if (Test-Path $inProject) { $KeyPath = $inProject }
    elseif (Test-Path $inDownloads) { $KeyPath = $inDownloads }
    else {
        $downloads = Join-Path $env:USERPROFILE "Downloads"
        if (Test-Path $downloads) {
            $any = Get-ChildItem -Path $downloads -Filter "*.pem" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($any) { $KeyPath = $any.FullName }
        }
    }
}

if (-not $KeyPath -or -not (Test-Path $KeyPath)) {
    Write-Host "Cle .pem introuvable. Lance avec -KeyPath `"C:\chemin\vers\ta-cle.pem`"" -ForegroundColor Yellow
    exit 1
}

# Vérifier que gh est installé et connecté
$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
    Write-Host "GitHub CLI (gh) n'est pas installe." -ForegroundColor Yellow
    Write-Host "  Installe-le : winget install GitHub.cli" -ForegroundColor Gray
    Write-Host "  Puis : gh auth login" -ForegroundColor Gray
    Write-Host "  Ensuite relance ce script." -ForegroundColor Gray
    exit 1
}

Push-Location $root
try {
    Write-Host "Configuration des secrets du repo polybot..." -ForegroundColor Cyan
    $keyContent = Get-Content -Path $KeyPath -Raw
    $keyContent | gh secret set LIGHTSAIL_SSH_KEY
    if ($LASTEXITCODE -ne 0) { throw "Echec LIGHTSAIL_SSH_KEY" }
    Write-Host "  LIGHTSAIL_SSH_KEY : OK" -ForegroundColor Green
    gh secret set LIGHTSAIL_HOST --body $HostIp
    if ($LASTEXITCODE -ne 0) { throw "Echec LIGHTSAIL_HOST" }
    Write-Host "  LIGHTSAIL_HOST    : OK ($HostIp)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Termine. Les prochains push sur bot-24-7 declencheront le redéploiement sur Lightsail." -ForegroundColor Green
} finally {
    Pop-Location
}
