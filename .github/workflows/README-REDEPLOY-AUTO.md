# Mise à jour automatique du bot sur Lightsail

Quand tu fais **git push** (surtout si tu modifies `bot-24-7/`), une GitHub Action se déclenche et exécute `~/bot-24-7/redeploy.sh` sur ton instance Lightsail. Le bot est mis à jour sans rien faire à la main.

## Une seule fois : configurer les secrets du repo

1. Va sur **https://github.com/jeuneMaitre667/polybot**
2. **Settings** → **Secrets and variables** → **Actions**
3. **New repository secret** pour chacun :

| Nom du secret    | Valeur |
|------------------|--------|
| `LIGHTSAIL_SSH_KEY` | Ouvre ta clé `.pem` (Lightsail) dans un éditeur, copie **tout** le contenu (y compris `-----BEGIN ...` et `-----END ...`) et colle-le ici. |
| `LIGHTSAIL_HOST`    | L’IP de ton instance Lightsail, ex. `18.203.159.101` |

Sans ces secrets, l’Action ne fait rien (et affiche un avertissement).

## Ensuite

- Tu modifies le code du bot → **git push** vers `main` (ou `master`).
- L’Action tourne, se connecte en SSH à Lightsail et lance `redeploy.sh`.
- Vérifier : onglet **Actions** du repo pour voir l’exécution et les éventuelles erreurs.
