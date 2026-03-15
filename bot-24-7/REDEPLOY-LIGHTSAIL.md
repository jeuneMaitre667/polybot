# Redéploiement du bot depuis Lightsail

Pour mettre à jour le bot **directement sur l’instance** (sans repasser par ton PC) :

## 1. Une seule fois : pousser le repo sur GitHub

- Crée un repo sur GitHub (ex. `polymarket-dashboard`).
- Pousse ton code :  
  `git remote add origin https://github.com/TON_USER/polymarket-dashboard.git`  
  puis `git push -u origin main` (ou `master`).

## 2. Une seule fois sur Lightsail : configurer l’URL du repo

En SSH sur l’instance :

```bash
nano ~/bot-24-7/.env
```

Ajoute une ligne (remplace par ton URL réelle) :

```
GIT_REPO_URL=https://github.com/TON_USER/polymarket-dashboard.git
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
