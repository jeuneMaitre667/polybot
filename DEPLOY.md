# Déploiement — bot Polymarket & dashboard

Guide court pour remettre en service ou mettre à jour **bot 24/7**, **serveur de statut** et **dashboard** (Vite).

## Prérequis

- Node.js **18+**
- **PM2** (`npm i -g pm2`) sur le VPS
- Port **3001** (ou autre) ouvert sur le pare-feu Lightsail / cloud si le dashboard appelle l’API statut depuis le navigateur

---

## 1. Bot (`bot-24-7/`)

```bash
cd bot-24-7
npm install
cp .env.example .env   # puis éditer PRIVATE_KEY, flags, etc.
pm2 start index.js --name polymarket-bot
pm2 save
```

- Les fichiers runtime (`balance.json`, `last-order.json`, `orders.log`, `health.json`, etc.) sont créés dans le même répertoire que `index.js` (ou selon `BOT_DIR` si tu l’utilises).
- Redémarrage : `pm2 restart polymarket-bot`

---

## 2. Serveur de statut (`bot-24-7/status-server.js`)

Exposé pour le dashboard (`/api/bot-status`). À lancer **sur la machine qui voit les fichiers du bot** (souvent la même que le bot).

```bash
cd bot-24-7
# Optionnel : même dossier que le bot (défaut = répertoire du script)
export BOT_DIR=/home/ubuntu/bot-24-7
export BOT_STATUS_PORT=3001
# Optionnel : export BOT_STATUS_SECRET=...  puis ?token=... dans l’URL
pm2 start status-server.js --name bot-status-server
pm2 save
```

- Après une **mise à jour** du code : `pm2 restart bot-status-server`
- Vérification : `curl -s http://127.0.0.1:3001/api/bot-status | head -c 200`

---

## 3. Dashboard (racine du repo)

```bash
npm install
```

Créer `.env` (ou variables d’environnement de build) :

```env
VITE_BOT_STATUS_URL=http://IP_OU_DOMAINE:3001
# Optionnel second bot 15m :
# VITE_BOT_STATUS_URL_15M=http://IP_BOT_15M:3001
# Si secret activé sur le status-server :
# VITE_BOT_STATUS_URL=http://...:3001?token=TON_SECRET
```

Build & preview local :

```bash
npm run build
npm run preview
```

En production : servir le dossier `dist/` derrière **HTTPS** (recommandé). Les appels Gamma/CLOB depuis le navigateur fonctionnent en direct ; en **dev**, Vite proxy `/api` et `/apiClob` vers Gamma/CLOB.

---

## 4. Checklist après déploiement

| Étape | Action |
|--------|--------|
| Bot | `pm2 logs polymarket-bot` — pas d’erreur boucle |
| Statut | `curl .../api/bot-status` — `balanceUsd`, `fillExecutionStats24h` si bot récent |
| Dashboard | Variables `VITE_*` présentes **au moment du `npm run build`** |
| Pare-feu | Port status-server joignable depuis **où** tu ouvres le dashboard |

---

## 5. Fichiers utiles

| Fichier | Rôle |
|---------|------|
| `bot-24-7/.env.example` | Liste des variables bot |
| `bot-24-7/orders.log` | Historique ordres (stats fill / FAK côté status-server) |
| `bot-24-7/health.json` | WS, kill switch, dernier ordre |

Pour le workflow GitHub → Lightsail, voir le fichier de workflow du repo (redeploy) si configuré.
