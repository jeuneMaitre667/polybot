# Bot Polymarket V2 Sniper ⚓🚀

Moteur de trading algorithmique optimisé pour le protocole **pUSD** de Polymarket V2. Spécialisé sur l'arbitrage de latence Bitcoin (Binance vs Polymarket).

## 📊 Stratégie de Production (v51.0.0 - Engine V2)

| Paramètre | Valeur | Description |
|-----------|--------|-------------|
| **Price Range** | `0.88 - 0.95` | Zone d'entrée sécurisée (Probabilité > 90%) |
| **Delta Seuil** | `0.067%` | Écart Binance-Spot vs Binance-Open pour déclencher |
| **Strike Source** | `Binance Open` | Le bot se fie à 100% à l'ouverture de la bougie 5m Binance |
| **Mise Fixe** | `$2.50 pUSD` | Gestion de risque conservative (Safety Mode) |
| **Stop-Loss** | `-14%` | Sortie de sécurité nette (Protocol Fees incl.) |
| **Delta Shield** | `0.04%` | Bloque le SL si l'asset progresse en faveur du trade |
| **Exit Logic** | `GTC-RAW` | Ordres bruts (Bypass SDK) pour garantir le remplissage |

## 🛠️ Architecture Technique V2 (Modularité Maximale)

- **Orchestration** : Code divisé en 5 modules (Config, Strategy, Clob, Execution, Sentinel) via `src/engine/index.js`.
- **Collatéral** : pUSD (Contrat `0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb`).
- **Signature** : EIP-712 v2 via `viem` (WalletAccount).
- **Execution** : `@polymarket/clob-client-v2` + Manual HMAC Headers.
- **Monitoring** : Exclusif via **Logs PM2** (Pipeline temps réel), Dashboard supprimé.
- **Sentinel** : Monitoring Turbo (200ms) indépendant du flux principal dans `src/engine/sentinel.js`.

## 🚀 Déploiement PM2 (Lightsail)

```bash
# Vérifier les processus
pm2 list

# Lancement officiel
pm2 start ecosystem.config.cjs --name poly-engine

# Logs temps réel (seule méthode de monitoring)
pm2 logs poly-engine
```

## 📈 Monitoring & Diagnostics

Le monitoring s'effectue **exclusivement via les logs de la pipeline** :
- **Visualiser la pipeline** : `pm2 logs poly-engine --lines 10`
- **Active Positions** : `cat active-positions.json`
- **V2 Approval Status** : Vérifier les logs au démarrage ("Allowance OK").

## 🛡️ Sécurité & Proxy
Le bot tourne en **connexion directe** (AWS `eu-west-1` Ireland) pour éviter les bannissements de proxy. 
- **Vérification** : `GET https://clob.polymarket.com/time` doit renvoyer un statut 200.

---
*Dernière mise à jour : v51.0.0 "ENGINE V2 (MODULAR PURE-BINANCE)"*
⚓⚡⚓
