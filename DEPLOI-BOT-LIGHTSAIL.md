# Déployer le bot sur Lightsail en une commande

## 1. Télécharger la clé SSH (si pas déjà fait)

- Ouvre [Lightsail → ton instance → onglet Connect](https://lightsail.aws.amazon.com/ls/webapp/eu-west-1/instances/bot-polymarket/connect).
- Clique sur **« Download default key »**.
- Le fichier (ex. `LightsailDefaultKey-eu-west-1.pem`) est enregistré dans **Téléchargements**.

## 2. Noter l’IP de l’instance

Sur la page **Connect** de ton instance, note l’**IPv4** (ex. `34.253.187.142`).

## 3. Lancer le déploiement

Dans **PowerShell**, depuis le dossier du projet :

```powershell
cd C:\Users\cedpa\polymarket-dashboard

.\deploy-bot.ps1 -KeyPath "$env:USERPROFILE\Downloads\LightsailDefaultKey-eu-west-1.pem" -Ip "34.253.187.142"
```

Remplace le nom du fichier `.pem` et l’IP si les tiens sont différents.

Le script envoie le dossier `bot-24-7` sur le serveur et exécute l’installation (Node, `npm install`, création de `.env`).

## 4. Mettre ta clé privée et lancer le bot

Connecte-toi en SSH :

```powershell
ssh -i "$env:USERPROFILE\Downloads\LightsailDefaultKey-eu-west-1.pem" ubuntu@34.253.187.142
```

Sur le serveur :

```bash
cd ~/bot-24-7
nano .env
```

Remplace `PRIVATE_KEY=0xREMPLACE_PAR_TA_CLE` par ta vraie clé (wallet Polygon), sauvegarde (Ctrl+O, Entrée, Ctrl+X).

Puis lance le bot :

```bash
npm start
```

Pour qu’il tourne 24/7 après déconnexion :

```bash
sudo npm install -g pm2
pm2 start index.js --name polymarket-bot
pm2 save
pm2 startup
```
