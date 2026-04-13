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
Push sur `main` avec des changements dans `bot-24-7/**` déclenche « Redeploy bot on Lightsail » : **déploiement du bot 15m uniquement** (`LIGHTSAIL_HOST_15M` / `LIGHTSAIL_SSH_KEY_15M`). Le bot horaire n’est plus déployé au push ; pour le horaire : **Actions → Run workflow** avec la cible `hourly` ou `both` (secrets `LIGHTSAIL_HOST` / `LIGHTSAIL_SSH_KEY`).

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

**Comportement du bot** : à chaque cycle (avant de placer des ordres), le bot tente `redeemPositions` sur le CTF pour tous les `conditionId` déjà tradés (lus depuis `orders.log` et `last-order.json`).

- **Délai après fin de marché (15m)** : pour chaque trade, le bot enregistre `marketEndMs` (fin du marché d’après Gamma) dans `last-order.json` / `orders.log`. Tant que `maintenant < marketEndMs + REDEEM_AFTER_MARKET_END_MS`, il **ne tente pas** le redeem pour ce `conditionId` — ça limite les `STATE_FAILED` juste après la cloche. Défaut si la variable n’est pas dans `.env` : **60 s** en `MARKET_MODE=15m`, **0** en hourly. Désactiver : `REDEEM_AFTER_MARKET_END_MS=0`. Ajuster : ex. `REDEEM_AFTER_MARKET_END_MS=120000` (2 min). Les anciens enregistrements **sans** `marketEndMs` ne sont pas concernés (redeem comme avant).

- **Compte EOA** (`CLOB_SIGNATURE_TYPE=0`) : transaction envoyée depuis le wallet (gas POL).
- **Compte proxy Magic / Safe** (`CLOB_SIGNATURE_TYPE=1` ou `2`) : le bot peut envoyer le redeem **via le relayer** (gasless), comme sur le site, avec **l’une** des deux authentifications documentées par Polymarket pour `/submit` :
  - **Clés Relayer** (souvent ce que tu as dans Paramètres → *Clés API du Relayer*) : `RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS` (l’adresse affichée à côté de la clé, en pratique la même que le **signataire** = l’adresse dérivée de `PRIVATE_KEY`).
  - **Clés Builder** (programme Builder) : `POLY_BUILDER_API_KEY`, `POLY_BUILDER_SECRET`, `POLY_BUILDER_PASSPHRASE`.

  Défaut : relayer activé dès que type 1/2 + l’une de ces configs. `REDEEM_VIA_RELAYER=false` force le redeem EOA ; `REDEEM_VIA_RELAYER=true` exige type 1/2 + une auth valide (sinon fallback EOA + log).

Tu peux désactiver toute étape redeem avec `REDEEM_ENABLED=false` dans `.env`.

**Sans aucune de ces creds sur un compte proxy** : le redeem EOA ne crédite souvent rien — configure les clés Relayer ou Builder, ou claim manuel sur [polymarket.com](https://polymarket.com).

**Si « rien n’est claim » alors que le site affiche résolu** :

1. Le bot ne redeem que les `conditionId` présents dans `orders.log` / `last-order.json`. Vérifie que ton trade est bien enregistré.
2. **Délai oracle** : l’UI peut afficher « résolu » avant que le CTF on-chain autorise `redeemPositions` — attendre et laisser le bot réessayer chaque cycle.
3. Consulte **`bot.log`** : `Redeem positions OK (relayer)` = succès ; `Redeem relayer sans succès` = tx relayer non confirmée ou **STATE_FAILED** (voir le hash sur Polygonscan — souvent revert « pas encore redeemable » ou pas de position).
4. **`pm2 logs polymarket-bot --err`** : lignes `failed onchain` = transaction envoyée mais revert.
5. **Position négligeable** : un fill CLOB minuscule peut donner un redeem sans effet visible sur le solde.
6. Dernier recours : **claim / merge** depuis [polymarket.com](https://polymarket.com) sur le marché résolu (même compte / proxy).

**Automatisation nocturne** : le bot retente le redeem **à chaque cycle** ; en cas d’échec (oracle pas prêt), il attend **`REDEEM_FAIL_BACKOFF_MS`** (défaut 2 min) avant de réessayer **le même** `conditionId`, ce qui évite de saturer le relayer tout en finissant par claim quand la chaîne est prête. Les marchés **déjà redeemés avec succès** sont enregistrés dans **`redeemed-condition-ids.json`** (dans `bot-24-7/`) pour ne plus les retenter. Si tu as **claim à la main**, ajoute le `conditionId` dans ce fichier JSON (tableau de chaînes) ou dans **`REDEEM_SKIP_CONDITION_IDS`** dans `.env`.

---

## 8. Backtest PnL (local)

Pour estimer le PnL théorique à partir des fichiers générés par le bot (sans toucher au serveur) :

```bash
cd bot-24-7
node backtest-pnl.js
```

Option : `node backtest-pnl.js --dir /chemin/vers/bot-24-7` pour cibler un autre dossier.

(Voir section 7 pour les gains / redeem.)
