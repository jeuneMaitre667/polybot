# Structure du projet — Polymarket Dashboard & Bot

Arborescence classée et décrite. Fichiers à ne pas committer : `.env`, `*.pem` (voir `.gitignore`).

---

## Racine du projet

| Fichier | Rôle |
|--------|------|
| `package.json` | Dépendances et scripts du **dashboard** (Vite, React). |
| `package-lock.json` | Versions figées des paquets npm. |
| `index.html` | Point d’entrée HTML du dashboard. |
| `vite.config.js` | Configuration Vite (build, dev server). |
| `tailwind.config.js` | Configuration Tailwind CSS. |
| `postcss.config.js` | PostCSS (pour Tailwind). |
| `eslint.config.js` | Règles ESLint. |
| `jsconfig.json` | Configuration JS (chemins, etc.). |
| `tsconfig.json` | Configuration TypeScript (composants UI .tsx). |
| `components.json` | Config shadcn/ui. |
| `.env.example` | Exemple de variables d’environnement (ex. `VITE_BOT_STATUS_URL`). |
| `.gitignore` | Fichiers ignorés par Git (`.env`, `*.pem`, `node_modules`, etc.). |
| `README.md` | Présentation du projet, démarrage rapide. |
| `STRUCTURE.md` | Ce fichier — structure et classement des fichiers. |

### Scripts de déploiement (Windows / PowerShell)

| Fichier | Rôle |
|--------|------|
| `deploy-bot.ps1` | Envoie `bot-24-7` sur Lightsail (SCP) et lance `setup-remote.sh` en SSH. |
| `setup-lightsail-git.ps1` | Configure le repo Git sur Lightsail et exécute le premier redéploiement. |
| `setup-github-secrets.ps1` | Enregistre les secrets GitHub (clé SSH, IP) pour l’Action de redéploiement auto. |
| `deploy-et-setup-git.ps1` | Script tout-en-un (déploiement + config Git). |
| `tout-faire-lightsail.ps1` | Enchaîne déploiement + config + commandes sur Lightsail. |

### Documentation déploiement

| Fichier | Rôle |
|--------|------|
| `DEPLOI-BOT-LIGHTSAIL.md` | Guide de déploiement du bot sur Lightsail. |
| `GITHUB-SETUP.md` | Configuration GitHub (repo, secrets, Actions). |

---

## `src/` — Dashboard React (Vite)

### Entrées et style

| Fichier | Rôle |
|--------|------|
| `main.jsx` | Point d’entrée React, rendu dans `#root`. |
| `App.jsx` | Composant racine : header (titre, BotStatusBadge), main (stratégie, historique, calculateur). |
| `index.css` | Styles globaux et imports Tailwind. |

### Composants (`src/components/`)

| Fichier | Rôle |
|--------|------|
| `BotStatus.jsx` | Hook `useBotStatus` + composant `BotStatusBadge` (header : statut, uptime, marché·3s, solde, dernier ordre). |
| `BitcoinUpDownStrategy.jsx` | Carte « Stratégie Bitcoin Up or Down » : règles, connexion wallet, résultats 24h, moyenne d’entrée, paramètres, simulateur. |
| `TradeHistory.jsx` | Affichage de l’historique des trades (Polymarket). |
| `CompoundInterestCalculator.jsx` | Calculateur d’intérêts composés. |
| `MarketCard.jsx` | Carte d’affichage d’un marché (réutilisable). |
| `FilterBar.jsx` | Barre de filtres. |
| `StatsHeader.jsx` | En-tête de statistiques. |
| `LoadingSpinner.jsx` | Indicateur de chargement. |

### Composants UI (`src/components/ui/`) — shadcn/ui

| Fichier | Rôle |
|--------|------|
| `button.tsx` | Bouton. |
| `card.tsx` | Card, CardHeader, CardContent, CardTitle. |
| `badge.tsx` | Badge. |
| `checkbox.tsx` | Case à cocher. |
| `label.tsx` | Label. |
| `select.tsx` | Liste déroulante. |
| `slider.tsx` | Slider. |

### Contexte et hooks

| Fichier | Rôle |
|--------|------|
| `context/WalletContext.jsx` | Contexte wallet (connexion MetaMask, Polygon, signer). |
| `hooks/useBitcoinUpDownSignals.js` | Récupère les signaux 96,8–97 % (Gamma), polling 5 s. |
| `hooks/useBitcoinUpDownResolved.js` | Récupère les créneaux Bitcoin Up or Down résolus + simulation bot. |
| `hooks/useTradeHistory.js` | Historique des trades (API Data). |
| `hooks/useMarkets.js` | Marchés Polymarket (optionnel). |

### Librairies et utilitaires

| Fichier | Rôle |
|--------|------|
| `lib/polymarketOrder.js` | Placement d’ordres CLOB (marché / limite) via `@polymarket/clob-client`. |
| `lib/utils.ts` | Utilitaires (ex. `cn()` pour classes). |
| `utils/formatters.js` | Formatage (argent, dates, etc.). |

---

## `bot-24-7/` — Bot Node.js 24/7

### Script principal et serveur de statut

| Fichier | Rôle |
|--------|------|
| `index.js` | Boucle principale : signaux Gamma, placement d’ordres CLOB (marché/limite), écriture `balance.json` et `last-order.json`. |
| `status-server.js` | Serveur HTTP (port 3001) : expose `/api/bot-status` (PM2, solde, dernier ordre, config, _debug). |

### Scripts shell (à exécuter sur Lightsail)

| Fichier | Rôle |
|--------|------|
| `redeploy.sh` | Git pull (repo configuré), copie du code dans `~/bot-24-7`, mise à jour `.env` (USE_MARKET_ORDER, POLL_INTERVAL_SEC), npm install, pm2 restart bot + status-server. |
| `update-and-restart.sh` | Appelle `redeploy.sh` (alias pour « tout mettre à jour et redémarrer »). |
| `fix-and-redeploy.sh` | Déplace `balance.json` / `last-order.json` du home vers `~/bot-24-7` si présents, puis lance `redeploy.sh`. |
| `setup-remote.sh` | Installation initiale sur le serveur (Node, npm install, création `.env`). |
| `start-pm2.sh` | Démarrage du bot avec PM2. |
| `pm2-startup.sh` | Configuration de PM2 pour redémarrage au boot. |
| `backup-env.sh` | Sauvegarde du `.env` (clé masquée). |
| `check-bot-health.sh` | Vérification que le bot tourne ; envoi d’alerte (Discord/Telegram) si down. |

### Config et doc du bot

| Fichier | Rôle |
|--------|------|
| `package.json` | Dépendances du bot (ethers, axios, clob-client, dotenv). |
| `.env.example` | Exemple de variables (PRIVATE_KEY, USE_MARKET_ORDER, POLL_INTERVAL_SEC, etc.). |
| `.gitignore` | Ignorer `.env`, `node_modules`, etc. dans le sous-dossier. |
| `README.md` | Doc du bot : installation, variables, PM2, géobloc, rate limits. |
| `STATUS-SERVER.md` | Doc du serveur de statut (port 3001, CORS, optionnel token). |
| `REDEPLOY-LIGHTSAIL.md` | Redéploiement depuis Lightsail (GitHub Actions ou manuel). |
| `ALERTES.md` | Configuration des alertes (Discord / Telegram) si le bot plante. |

---

## `public/`

| Fichier | Rôle |
|--------|------|
| `icons.svg` | Icônes (assets statiques). |

---

## `.github/`

| Fichier | Rôle |
|--------|------|
| `workflows/redeploy-bot-lightsail.yml` | Action GitHub : redéploiement automatique du bot sur Lightsail (sur push, avec secrets SSH). |
| `workflows/README-REDEPLOY-AUTO.md` | Explication de l’Action (secrets à configurer). |

---

## `.cursor/rules/` — Règles Cursor (IA)

| Fichier | Quand ça s’applique | Rôle |
|--------|----------------------|------|
| `00-conventions.mdc` | Toujours | Langue (français), structure, secrets, stack, SSH. |
| `01-dashboard-react.mdc` | Fichiers `src/**/*.jsx`, `*.js`, `*.css` | Composants React, Tailwind, wallet, API bot. |
| `02-bot-node.mdc` | Fichiers `bot-24-7/**/*` | ESM, .env, BOT_DIR, scripts shell, status-server. |
| `03-deploiement.mdc` | Fichiers `*.ps1`, `*.sh`, `.github/**/*` | Lightsail, redeploy, clé SSH, port 3001. |

---

## Fichiers hors repo (à ne pas committer)

| Fichier | Rôle |
|--------|------|
| `.env` | Variables d’environnement du dashboard (ex. `VITE_BOT_STATUS_URL=http://IP:3001`). |
| `*.pem` | Clé SSH Lightsail (ex. `LightsailDefaultKey-eu-west-1.pem`) — utilisée par les scripts PowerShell et pour SSH depuis le PC. |

---

## Résumé par usage

- **Lancer le dashboard en local** : `npm run dev` (racine).
- **Lancer le bot en local** : `cd bot-24-7 && npm start`.
- **Déployer le bot sur Lightsail** : `.\deploy-bot.ps1` ou `.\setup-lightsail-git.ps1` (puis en SSH : `bash ~/bot-24-7/redeploy.sh`).
- **Mettre à jour le bot sur Lightsail** : en SSH `bash ~/bot-24-7/redeploy.sh` ou `bash ~/bot-24-7/update-and-restart.sh`.
- **Voir le statut du bot** : dashboard (header) ou `http://IP_LIGHTSAIL:3001/api/bot-status`.
