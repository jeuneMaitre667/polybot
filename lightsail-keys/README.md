# Clés SSH Lightsail

Ce dossier contient les clés `.pem` pour se connecter aux instances Lightsail (non suivies par Git).

| Fichier | Instance | IP |
|--------|----------|-----|
| `LightsailDefaultKey-eu-west-1.pem` | Bot horaire | 63.34.0.38 |
| `LightsailDefaultKey-eu-west-1-bot15m.pem` | Bot 15m | 63.34.0.38 |

**Exemple (PowerShell)** :
```powershell
ssh -i "c:\Users\cedpa\polymarket-dashboard\lightsail-keys\LightsailDefaultKey-eu-west-1.pem" -o StrictHostKeyChecking=no ubuntu@63.34.0.38
ssh -i "c:\Users\cedpa\polymarket-dashboard\lightsail-keys\LightsailDefaultKey-eu-west-1-bot15m.pem" -o StrictHostKeyChecking=no ubuntu@63.34.0.38
```
