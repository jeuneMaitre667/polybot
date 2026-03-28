# Clés SSH Lightsail

Ce dossier contient les clés `.pem` pour se connecter aux instances Lightsail (non suivies par Git).

| Fichier | Instance | IP |
|--------|----------|-----|
| `LightsailDefaultKey-eu-west-1.pem` | (ancienne / autre) | selon instance |
| `LightsailDefaultKey-eu-west-1-bot15m.pem` | (ancienne / autre) | selon instance |
| **`clé 2gb ram bot15m.pem`** | **bot15m2gbRAM** (actuelle) | **63.34.0.38** |

Le secret GitHub **`LIGHTSAIL_SSH_KEY`** doit contenir le **texte complet** du fichier utilisé pour l’instance (souvent `clé 2gb ram bot15m.pem`).

**Exemple (PowerShell)** — instance actuelle :
```powershell
ssh -i "c:\Users\cedpa\polymarket-dashboard\lightsail-keys\clé 2gb ram bot15m.pem" -o StrictHostKeyChecking=accept-new ubuntu@63.34.0.38
```
