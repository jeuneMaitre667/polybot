# Runbook — Bot Polymarket & Dashboard

Checklist et commandes utiles en cas de problème.

---

## 1. Le bot ne répond plus (status-server down ou bot arrêté)

**Symptômes** : dashboard affiche « Hors ligne », pastille rouge, ou `http://IP:3001/api/bot-status` ne répond pas.

**À faire :**

1. Se connecter en SSH à l’instance Lightsail :
   ```bash
   ssh -i chemin/vers/ta-cle.pem ubuntu@IP_LIGHTSAIL
   ```

2. Vérifier les processus PM2 :
   ```bash
   pm2 list
   ```
   - Si `polymarket-bot` ou `bot-status-server` est en `stopped` / `errored` : redémarrer :
     ```bash
     cd ~/bot-24-7
     pm2 restart polymarket-bot
     pm2 restart bot-status-server
     pm2 save
     ```

3. Consulter les logs :
   ```bash
   pm2 logs polymarket-bot --lines 100
   pm2 logs bot-status-server --lines 50
   ```

4. Si le bot crash en boucle : vérifier `~/bot-24-7/.env` (PRIVATE_KEY, RPC, etc.) et les messages d’erreur dans les logs.

---

## 2. Le status-server (port 3001) ne répond pas

**Symptômes** : curl ou le dashboard n’atteint pas `http://IP:3001/api/bot-status`.

**À faire :**

1. SSH sur l’instance (voir ci-dessus).

2. Vérifier que le status-server tourne :
   ```bash
   pm2 list
   curl -s http://localhost:3001/api/health
   ```
   Si pas de réponse : `pm2 start ~/bot-24-7/status-server.js --name bot-status-server` (ou redémarrer si déjà présent).

3. Vérifier le pare-feu Lightsail : dans la console AWS, instance → Réseau, le port **3001** doit être ouvert (règle TCP entrante).

---

## 3. Le dashboard ne charge pas ou erreur blanche

**Symptômes** : la page du dashboard (Vite / build) ne s’affiche pas ou erreur dans la console navigateur.

**À faire :**

1. Vérifier que l’app tourne : `npm run dev` (dev) ou servir le dossier `dist/` (build).
2. Vérifier la variable d’environnement : `VITE_BOT_STATUS_URL` doit pointer vers `http://IP_LIGHTSAIL:3001` (sans slash final) si tu utilises le statut bot.
3. CORS : le status-server autorise `*` ; en cas de blocage, vérifier que l’URL du bot est bien HTTP(S) et accessible depuis ton navigateur.

---

## 4. Redéploiement complet (code à jour)

Sur ton PC (après un push) ou pour forcer une mise à jour sur le serveur :

**Option A — GitHub Action (automatique)**  
Push sur `main` avec des changements dans `bot-24-7/**` déclenche le workflow « Redeploy bot on Lightsail » (si les secrets sont configurés).

**Option B — À la main en SSH**  
Sur l’instance :
```bash
bash ~/bot-24-7/redeploy.sh
```
Cela fait : pull du repo, copie du code vers `~/bot-24-7`, `npm install`, redémarrage de `polymarket-bot` et `bot-status-server`.

---

## 5. Vérification rapide après déploiement

Sur le serveur (ou depuis ton PC si le port 3001 est exposé) :

```bash
# Sur le serveur
curl -s http://localhost:3001/api/bot-status | head -c 500
pm2 list
```

Un script dédié est dans `bot-24-7/verify-deploy.sh` (voir section suivante).

---

## 6. Alertes (bot down)

Pour recevoir une alerte (Discord ou Telegram) quand le bot s’arrête :

1. Configurer les variables dans `~/bot-24-7/.env` (voir `bot-24-7/ALERTES.md`).
2. Vérifier le cron : `crontab -l` doit contenir une ligne du type :
   ```text
   */5 * * * * bash /home/ubuntu/bot-24-7/check-bot-health.sh
   ```
3. Pour vérifier que tout est en place : `bash ~/bot-24-7/check-alertes-setup.sh`
4. Tester : arrêter le bot (`pm2 stop polymarket-bot`), attendre 5 min, vérifier la réception de l’alerte, puis redémarrer le bot.

---

## 7. Gains (claim / redeem) après un trade gagnant

Sur Polymarket, **les gains ne sont pas crédités en USDC automatiquement** : une fois le marché résolu, les tokens gagnants doivent être **redeem** (échangés contre USDC via le contrat CTF). Tant que ce n’est pas fait, le solde USDC affiché n’inclut pas ces gains et le bot pourrait trader le créneau suivant avec un solde trop bas.

**Comportement du bot** : à chaque cycle (avant de placer des ordres), le bot tente d’appeler `redeemPositions` sur le contrat CTF pour tous les `conditionId` pour lesquels il a déjà placé un ordre (lus depuis `orders.log` et `last-order.json`). Si les positions sont bien sur ton wallet (EOA), les gains sont alors crédités en USDC. Tu peux désactiver cette étape avec `REDEEM_ENABLED=false` dans `.env`.

**Si le solde ne remonte pas après un gain** : Polymarket utilise parfois un **wallet proxy** (Safe) pour détenir les positions. Dans ce cas, le redeem depuis l’EOA ne fait rien (0 token à redeem). Il faut alors **claim depuis le site Polymarket** : connecte le même wallet sur [polymarket.com](https://polymarket.com), va sur le marché résolu et utilise l’option pour réclamer les gains. Une fois les tokens redeem, le solde USDC sera à jour et le bot pourra réinvestir au prochain créneau.

---

## 8. Backtest PnL (local)

Pour estimer le PnL théorique à partir des fichiers générés par le bot (sans toucher au serveur) :

```bash
cd bot-24-7
node backtest-pnl.js
```

Option : `node backtest-pnl.js --dir /chemin/vers/bot-24-7` pour cibler un autre dossier.

(Voir section 7 pour les gains / redeem.)
