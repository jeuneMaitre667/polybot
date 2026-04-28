# Structure du projet — Polymarket V2 Sniper ⚓🚀

Arborescence classée et décrite. Fichiers à ne pas committer : `.env`, `*.pem`.

---

## 🏗️ Racine du projet

| Fichier | Rôle |
|--------|------|
| `package.json` | Dépendances et scripts du **dashboard** (Vite, React). |
| `vite.config.js` | Configuration Vite (build, dev server). |
| `README.md` | Présentation V2, démarrage rapide et specs Prod. |
| `STRUCTURE.md` | Ce fichier — structure et classement des fichiers. |
| `RUNBOOK.md` | Manuel opératoire pour la maintenance V2. |
| `.env.example` | Template des variables globales. |

### 🛰️ Scripts de gestion (PowerShell)
| Fichier | Rôle |
|--------|------|
| `deploy-bot.ps1` | Envoi sécurisé du bot vers Lightsail. |
| `tout-faire-lightsail.ps1` | Automatisation complète (déploiement + setup). |

---

## 🤖 `bot-24-7/` — Moteur Sniper V2 (Node.js)

### 🧠 Logique de Trading (Core)
| Fichier | Rôle |
|--------|------|
| `index.js` | Moteur principal : boucle sniper, CLOB V2, arbitrage Binance. |
| `risk-manager.js` | **Gestionnaire de Risque** : Anti-Glitch Shield, Stop-Loss dynamique, Fixed Stake. |
| `analytics-engine.js` | Moteur d'analyse : calcul des performances et archivage des trades. |
| `ManualSigner.js` | Utilitaire de signature EIP-712 pour les transactions pUSD. |
| `ecosystem.config.cjs` | Configuration PM2 pour instance unique (`polybot-v2`). |

### 🛠️ Utilitaires & Maintenance
| Fichier | Rôle |
|--------|------|
| `status-server.js` | API de monitoring (port 3001) pour le dashboard. |
| `redeploy.sh` | Script de mise à jour à chaud via Git Pull sur le serveur. |
| `health-v17.json` | Bulletin de santé temps réel (latence, slots, performance). |
| `session_grand_report.md` | Rapport d'audit de session (trades réels vs simu). |
| `trades-history-final.json` | Registre officiel de tous les trades exécutés. |

---

## 🎨 `src/` — Dashboard React (Monitoring)

| Fichier | Rôle |
|--------|------|
| `App.jsx` | Interface principale avec BotStatusBadge et Analytics. |
| `context/WalletContext.jsx` | Gestion de la connexion Polygon (MetaMask). |
| `hooks/useBotStatus.js` | Récupère la santé et le solde pUSD du bot via le serveur de statut. |
| `lib/polymarketOrder.js` | Logique d'ordre partagée avec le dashboard. |

---

## 📜 `règles IDE/` — Configuration IA (Cursor)

| Fichier | Rôle |
|--------|------|
| `00-conventions.mdc` | Règles de codage et conventions de langue. |
| `02-bot-node.mdc` | Spécifications Sniper (Range 0.88-0.95, Delta 0.07%). |
| `03-deploiement.mdc` | Procédures PM2 et accès SSH Lightsail (63.34.0.38). |

---

## 📂 Autres dossiers
- `scripts/` — Scripts utilitaires (backtest, audits spécifiques).
- `simulator-dashboard/` — Simulateur Monte Carlo indépendant.
- `public/data/` — Caches et données de backtest.

---

## 🚀 Résumé Maintenance
- **Mise à jour** : `git push` puis SSH `bash ~/polybot/bot-24-7/redeploy.sh`.
- **Relance** : `pm2 restart polybot-v2`.
- **Audit** : Consulter `bot-24-7/session_grand_report.md`.

