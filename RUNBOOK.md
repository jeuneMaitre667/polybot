# Runbook V2 Production — Sniper Polymarket ⚓🚀

Checklist et commandes vitales pour la maintenance du bot sur AWS Lightsail.

---

## 1. Relance et Monitoring (Urgence)

**Symptômes** : Dashboard hors ligne ou Delta à 0.00% figé.

1. **SSH sur la Prod** (IP: `63.34.0.38`) :
   ```bash
   ssh -i "path/to/key.pem" ubuntu@63.34.0.38
   ```

2. **Commandes PM2** :
   ```bash
   # Voir l'état des processus (polybot-v2 et bot-status-server)
   pm2 list

   # Redémarrage (Si plantage ou freeze)
   pm2 restart polybot-v2
   pm2 restart bot-status-server
   ```

3. **Vérification des Logs** :
   ```bash
   # Logs en direct (Sniper & Binance)
   pm2 logs polybot-v2 --lines 50

   # Vérifier si des ordres passent
   tail -f ~/polybot/bot-24-7/trades-history-final.json
   ```

---

## 2. Mise à jour du Code (Hot-Reload)

Pour appliquer une modification poussée sur GitHub :

```bash
ssh -i "..." ubuntu@63.34.0.38
cd ~/polybot/bot-24-7
git pull
pm2 restart polybot-v2
```

---

## 3. Gestion des Fonds (pUSD)

Le bot utilise désormais le protocole **pUSD** (V2).

1. **Auto-Redeem** : Polymarket active souvent l'auto-redeem. Si le bot affiche `[Redeem] ⚠️ Déjà effectué (Auto-Redeem)`, c'est normal et sans danger.
2. **Solde insuffisant** : Si `Mise Fixe ($3.00) > Bal`, le bot suspendra le tir.
3. **Frais Gas** : Vérifier qu'il reste au moins **2 MATIC** sur le wallet pour les signatures et transactions.

---

## 4. Alertes & Sécurité

1. **Proxy** : Le bot utilise un proxy pour bypass le geoblock. Si les logs affichent `403 Forbidden`, vérifiez `PROXY_URL` dans le `.env` du serveur.
2. **Alertes Telegram** : Si vous recevez des doublons, vérifiez qu'il n'y a pas un processus fantôme (`pm2 delete all && pm2 start ecosystem.config.cjs`).
3. **Anti-Glitch** : Si un trade ne se ferme pas en SL alors qu'il devrait, vérifiez si le prix BTC a bougé de plus de 0.3% (Le bouclier bloque alors le SL pour attendre un rebond).

---

## 5. Audit de Performance

Pour analyser la session actuelle sans toucher au code :
```bash
# Rapport d'exécution détaillé
cat ~/polybot/bot-24-7/session_grand_report.md

# Historique des ordres réels
cat ~/polybot/bot-24-7/trades-history-final.json
```

---
*En cas de doute, privilégiez toujours `pm2 restart polybot-v2`.*

