# Redéploiement du bot depuis Lightsail

## Option A : Mise à jour automatique (recommandé)

Dès que tu modifies le code du bot et fais **git push** sur `main` (ou `master`), une GitHub Action se connecte à Lightsail et lance `~/bot-24-7/redeploy.sh`. **Aucune action manuelle** sur le serveur.

**Une seule fois** : ajoute les secrets du repo GitHub (Settings → Secrets and variables → Actions) :
- **LIGHTSAIL_SSH_KEY** : contenu complet de ton fichier `.pem` Lightsail
- **LIGHTSAIL_HOST** : IP de l’instance (ex. `63.34.0.38`)

Détail : voir `.github/workflows/README-REDEPLOY-AUTO.md` à la racine du projet.

---

## Option B : Redéploiement manuel depuis le serveur

Pour mettre à jour le bot **à la main** en SSH sur l’instance :

## 1. Une seule fois : pousser le repo sur GitHub

- Crée un repo sur GitHub (ex. `polymarket-dashboard`).
- Pousse ton code :  
  `git remote add origin https://github.com/jeuneMaitre667/polybot.git`  
  puis `git push -u origin main` (ou `master`).

## 2. Une seule fois sur Lightsail : configurer l’URL du repo

En SSH sur l’instance :

```bash
nano ~/bot-24-7/.env
```

Ajoute une ligne (remplace par ton URL réelle) :

```
GIT_REPO_URL=https://github.com/jeuneMaitre667/polybot.git
```

Enregistre (Ctrl+O, Entrée) et quitte (Ctrl+X).

## 3. Rendre le script exécutable (une fois)

```bash
chmod +x ~/bot-24-7/redeploy.sh
```

## 4. À chaque fois que tu veux redéployer

Sur ton PC : pousse les changements vers GitHub (`git push`).

Puis en SSH sur Lightsail :

```bash
~/bot-24-7/redeploy.sh
```

Le script fait : `git pull` → copie du code dans `~/bot-24-7` (en gardant ton `.env`) → `npm install` → `pm2 restart polymarket-bot`.

---

**Si le script n’existe pas encore sur le serveur** (premier déploiement), envoie d’abord le dossier une fois depuis ton PC :

```powershell
.\deploy-bot.ps1
```

Ensuite configure `GIT_REPO_URL` dans `.env` et utilise `~/bot-24-7/redeploy.sh` pour les mises à jour.
