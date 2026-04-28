# Bot Polymarket V2 Sniper ⚓🚀

Moteur de trading algorithmique optimisé pour le protocole **pUSD** de Polymarket V2. Spécialisé sur l'arbitrage de latence Bitcoin (Binance vs Polymarket).

## 📊 Stratégie de Production (Config Actuelle)

| Paramètre | Valeur | Description |
|-----------|--------|-------------|
| **Price Range** | `0.88 - 0.95` | Zone d'entrée sécurisée (Probabilité > 90%) |
| **Delta Seuil** | `0.07%` | Écart Binance-Spot vs Polymarket-Strike pour déclencher |
| **Mise Fixe** | `$3.00 pUSD` | Gestion de risque conservatrice |
| **Stop-Loss** | `-15%` | Sortie de sécurité nette |
| **Anti-Glitch** | `0.3%` | Bloque le SL si l'asset progresse en faveur du trade |
| **Exit Logic** | `Smart Sweep` | Lecture du carnet d'ordres pour garantir le fill FOK |

## 🛠️ Architecture Technique V2

- **Collatéral** : pUSD (Contrat `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`).
- **Signature** : EIP-712 v2 via `viem` (WalletClient).
- **Execution** : `@polymarket/clob-client-v2`.
- **Redeem** : Gazless via Relayer V2, détection automatique de l'auto-redeem Polymarket.

## 🚀 Déploiement PM2 (Instance Unique)

Pour garantir qu'un seul processus tourne et éviter les notifications Telegram en doublon :

```bash
# Vérifier les processus
pm2 list

# Lancement officiel (Instance Unique)
pm2 start ecosystem.config.cjs --name polybot-v2

# Nettoyage si poly-engine est présent (ID fantôme)
pm2 delete poly-engine
pm2 save --force
```

## 📈 Monitoring & Logs

- **Logs temps réel** : `pm2 logs polybot-v2`
- **Santé interne** : `cat health-v17.json`
- **Statut Web** : Accessible sur le port 3001 via le dashboard.

## 🛡️ Sécurité & Proxy
Le bot doit impérativement tourner derrière un proxy autorisé (ex: Irlande/Dublin) pour éviter le geoblock `403`. 
- **Région recommandée** : AWS `eu-west-1`.
- **Vérification** : `GET https://clob.polymarket.com/time` via proxy doit renvoyer un 200.

---
*Optimisé pour le trading 24/7 sur AWS Lightsail.*

