# Mise à jour automatique du bot sur Lightsail

Quand tu fais **git push** sur `main` avec des changements sous **`bot-24-7/**`**, une GitHub Action se déclenche et exécute `ci-redeploy-remote.sh` sur l’instance **bot 15m**.

## Secrets à configurer (repo → Settings → Secrets and variables → Actions)

### Déploiement **15m** sur push (obligatoire pour ce flux)

| Nom du secret | Valeur |
|---------------|--------|
| **`LIGHTSAIL_HOST_15M`** | IP publique de l’instance 15m, ex. **`63.34.0.38`** |
| **`LIGHTSAIL_SSH_KEY_15M`** | Contenu **complet** du fichier `.pem` (celui qui ouvre cette instance, ex. `clé 2gb ram bot15m.pem`), du `-----BEGIN` au `-----END`. |

Sans **`LIGHTSAIL_HOST_15M`** ou **`LIGHTSAIL_SSH_KEY_15M`**, l’étape « Deploy bot 15m » échoue ou ne peut pas s’authentifier.

### Bot **horaire** (uniquement si tu lances le workflow à la main et choisis *hourly* / *both*)

| Nom du secret | Valeur |
|---------------|--------|
| `LIGHTSAIL_HOST` | IP de l’instance horaire |
| `LIGHTSAIL_SSH_KEY` | Clé `.pem` correspondante (plein texte) |

## Ensuite

- Tu modifies le code sous **`bot-24-7/`** → **git push** vers `main`.
- Onglet **Actions** : vérifier **Redeploy bot on Lightsail**.
