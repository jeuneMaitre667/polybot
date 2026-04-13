# Polymarket Dashboard & Bot

- **Dashboard** : app React (Vite) pour suivre les marchés Polymarket, la stratégie Bitcoin Up or Down, l’historique des trades et un calculateur d’intérêts composés.
- **Bot 24/7** : script Node.js qui tourne sur une instance (ex. AWS Lightsail), surveille les signaux Bitcoin Up or Down et place des ordres sur le CLOB Polymarket.

## Démarrage rapide

### Dashboard

```bash
npm install
npm run dev
```

### Bot (local)

```bash
cd bot-24-7
cp .env.example .env
# Éditer .env : PRIVATE_KEY=0x...
npm install
npm start
```

### Déploiement du bot sur Lightsail

1. Depuis ton PC : `.\deploy-et-setup-git.ps1 (tout-en-un) ou .\deploy-bot.ps1` (envoie le dossier `bot-24-7` sur l’instance).
Config Git + redeploy depuis GitHub : `.\setup-lightsail-git.ps1`. En SSH : `PRIVATE_KEY` dans `~/bot-24-7/.env` puis `pm2 restart polymarket-bot`.

Pour **redéployer depuis Lightsail** (sans repasser par le PC), voir `bot-24-7/REDEPLOY-LIGHTSAIL.md`.

## Structure

- `src/` — code du dashboard (React, composants, hooks, contexte wallet).
- `bot-24-7/` — bot Node (signaux Gamma, CLOB, solde USDC via API, ordres limite/marché).

**Vue détaillée** : voir [STRUCTURE.md](STRUCTURE.md) pour la liste classée et décrite de tous les fichiers du projet.

## Licence

Usage personnel / projet perso.
