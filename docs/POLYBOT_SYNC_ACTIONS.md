# Synchroniser le workflow GitHub Actions avec le repo **polybot**

Je n’ai pas accès à pousser sur `github.com/jeuneMaitre667/polybot` depuis cet environnement. À faire **une fois** (ou à chaque changement du workflow) :

1. Copier **`docs/github-actions-redeploy-lightsail.yml`** → polybot **`.github/workflows/redeploy-bot-lightsail.yml`**
2. **Secrets** : pour les pushes automatiques il faut **`LIGHTSAIL_SSH_KEY_15M`** + **`LIGHTSAIL_HOST_15M`**. Le bot **horaire** n’est plus déployé au push ; pour le relancer à la main : secrets **`LIGHTSAIL_SSH_KEY`** + **`LIGHTSAIL_HOST`**, puis **Run workflow** → cible **`hourly`** ou **`both`**.
3. **Run workflow** : défaut **`15m`** ; options **`hourly`** / **`both`** si besoin.

## Relancer un job qui a échoué

Sur GitHub : **Actions** → run en échec → **Re-run failed jobs** (ou **Re-run all jobs**).

Le job a aussi une limite **`timeout-minutes: 90`** côté GitHub pour éviter les runs de plusieurs heures.
