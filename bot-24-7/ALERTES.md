# Alerte si le bot plante

Le script `check-bot-health.sh` vérifie que le processus **poly-engine** est en ligne. S’il ne l’est pas, une alerte est envoyée (Discord ou Telegram).

## Configuration

Dans `~/bot-24-7/.env` sur le serveur, ajoute **une** des deux options :

### Discord

1. Crée un webhook dans ton serveur Discord (Paramètres du salon → Intégrations → Webhooks).
2. Ajoute dans `.env` :
   ```
   ALERT_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/ID/TOKEN
   ```

### Telegram

1. Crée un bot avec [@BotFather](https://t.me/BotFather), récupère le token.
2. Récupère ton chat ID (ex. en envoyant un message au bot puis ouvrant `https://api.telegram.org/bot<TOKEN>/getUpdates`).
3. Ajoute dans `.env` :
   ```
   ALERT_TELEGRAM_BOT_TOKEN=123456:ABC...
   ALERT_TELEGRAM_CHAT_ID=987654321
   ```

## Cron (toutes les 5 minutes)

En SSH sur Lightsail :

```bash
crontab -e
```

Ajoute la ligne :

```
*/5 * * * * bash /home/ubuntu/bot-24-7/check-bot-health.sh
```

Sauvegarde et quitte. Le script s’exécutera toutes les 5 minutes et enverra une alerte si le bot n’est plus « online ».

## Alertes temps réel (trade, redeem, solde)

Avec **`ALERT_TELEGRAM_BOT_TOKEN`** et **`ALERT_TELEGRAM_CHAT_ID`** remplis, le processus **`index.js`** envoie aussi :

- **Trade** : après un ordre accepté (WS ou poll) — côté Up/Down, montant demandé / exécuté, prix moyen, `conditionId`, fin de marché, **PnL latente** estimée (valeur au best bid vs coût), **solde pUSD** après trade, **Δ solde depuis le démarrage du bot** (premier solde noté).
- **Redeem** : succès (lien implicite via hash tx dans le message) ou échec ; solde pUSD via RPC après l’événement. Les échecs relayer « sans MINED » suivent le même throttle que le log console (évite le spam).
- **Solde seul** (optionnel) : `ALERT_TELEGRAM_BALANCE_EVERY_MS` en millisecondes (ex. `3600000` = 1 h), uniquement lors des cycles où le bot exécute le bloc solde (autotrade actif).

Désactiver partiellement : `ALERT_TELEGRAM_TRADE=false` ou `ALERT_TELEGRAM_REDEEM=false`. Redémarrer : `pm2 restart poly-engine`.

Les messages dédiés `stop-loss` (déclenchement + vente remplie) sont désactivables via : `ALERT_TELEGRAM_STOPLOSS=false`. Redémarrer : `pm2 restart poly-engine`.
