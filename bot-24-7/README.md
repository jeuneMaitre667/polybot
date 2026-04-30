# Bot Polymarket V2 Sniper ⚓🚀

Moteur de trading algorithmique optimisé pour le protocole **pUSD** de Polymarket V2. Spécialisé sur l'arbitrage de latence Bitcoin (Binance vs Polymarket).

## 📊 Stratégie de Production (v50.5.10)

| Paramètre | Valeur | Description |
|-----------|--------|-------------|
| **Price Range** | `0.88 - 0.95` | Zone d'entrée sécurisée (Probabilité > 90%) |
| **Delta Seuil** | `0.07%` | Écart Binance-Spot vs Polymarket-Strike pour déclencher |
| **Mise Fixe** | `$2.50 pUSD` | Gestion de risque conservative (Safety Mode) |
| **Stop-Loss** | `-14%` | Sortie de sécurité nette (Protocol Fees incl.) |
| **Delta Shield** | `0.04%` | Bloque le SL si l'asset progresse en faveur du trade |
| **Exit Logic** | `GTC-RAW` | Ordres bruts (Bypass SDK) pour garantir le remplissage |

## 🛠️ Architecture Technique V2

- **Collatéral** : pUSD (Contrat `0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb`).
- **Signature** : EIP-712 v2 via `viem` (WalletAccount).
- **Execution** : `@polymarket/clob-client-v2` + Manual HMAC Headers.
- **Sentinel** : Monitoring Turbo (200ms) indépendant du flux principal.
- **V2-Shield** : Vérification et approbation automatique (Allowance) des contrats V2 au démarrage.

## 🚀 Déploiement PM2 (Lightsail)

```bash
# Vérifier les processus
pm2 list

# Lancement officiel
pm2 start ecosystem.config.cjs --name poly-engine

# Logs temps réel
pm2 logs poly-engine
```

## 📈 Monitoring & Diagnostics

- **Internal Health** : `cat health-v17.json`
- **Active Positions** : `cat active-positions.json`
- **V2 Approval Status** : Vérifier les logs au démarrage ("Allowance OK").

## 🛡️ Sécurité & Proxy
Le bot tourne sous proxy **Dublin-Ghost** (AWS `eu-west-1`) pour contourner le geoblock `403/405`. 
- **Vérification** : `GET https://clob.polymarket.com/time` doit renvoyer un statut 200.

---
*Dernière mise à jour : v50.5.10 "FULL-V2-SHIELD-FIX"*
⚓⚡⚓

