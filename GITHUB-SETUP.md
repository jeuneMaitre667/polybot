# Créer le dépôt GitHub et pousser le projet

Le dépôt Git est déjà initialisé et un premier commit a été fait. Il reste à créer le repo sur GitHub et à pousser le code.

## 1. Créer le dépôt sur GitHub

1. Va sur [github.com](https://github.com) et connecte-toi.
2. Clique sur **« + »** → **« New repository »**.
3. Renseigne :
   - **Repository name** : `polymarket-dashboard` (ou un autre nom).
   - **Visibility** : Private ou Public.
   - Ne coche **pas** « Add a README » (tu en as déjà un).
4. Clique sur **« Create repository »**.

## 2. Lier le projet et pousser

Dans un terminal, à la racine du projet (`polymarket-dashboard`) :

```bash
git remote add origin https://github.com/TON_USERNAME/polymarket-dashboard.git
git branch -M main
git push -u origin main
```

Remplace `TON_USERNAME` par ton identifiant GitHub. Si tu as choisi un autre nom de repo, adapte l’URL.

Sous Windows (PowerShell), tu peux utiliser les mêmes commandes. Si on te demande de te connecter, utilise ton compte GitHub (ou un token).

## 3. Ensuite : redéploiement depuis Lightsail

Une fois le code sur GitHub, tu peux utiliser le script de redéploiement sur Lightsail :

1. Sur l’instance : ajoute dans `~/bot-24-7/.env` la ligne (ou laisse le workflow le faire au premier déploiement) :
   ```
   GIT_REPO_URL=https://github.com/jeuneMaitre667/polybot.git
   ```
2. Puis exécute : `~/bot-24-7/redeploy.sh` (après avoir fait `chmod +x ~/bot-24-7/redeploy.sh` une fois).

Voir `bot-24-7/REDEPLOY-LIGHTSAIL.md` pour le détail.
