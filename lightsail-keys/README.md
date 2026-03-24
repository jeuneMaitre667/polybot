# Clés SSH Lightsail

Ce dossier contient les clés `.pem` pour se connecter aux instances Lightsail (non suivies par Git).

| Fichier | Instance | IP |
|--------|----------|-----|
| `LightsailDefaultKey-eu-west-1.pem` | Bot horaire | 18.201.105.68 |
| `LightsailDefaultKey-eu-west-1-bot15m.pem` | Bot 15m | 18.203.159.101 |

**Exemple (PowerShell)** :
```powershell
ssh -i "c:\Users\cedpa\polymarket-dashboard\lightsail-keys\LightsailDefaultKey-eu-west-1.pem" -o StrictHostKeyChecking=no ubuntu@18.201.105.68
ssh -i "c:\Users\cedpa\polymarket-dashboard\lightsail-keys\LightsailDefaultKey-eu-west-1-bot15m.pem" -o StrictHostKeyChecking=no ubuntu@18.203.159.101
```
