# ⚓ POLYBOT V2 - RUNBOOK OPÉRATIONNEL ⚓

## 🚀 État de Santé Critique
*   **Processus Maître** : `polybot-v2` (PM2 ID 0)
*   **Serveur de Statut** : `bot-status-server` (PM2 ID 1)
*   **Mode** : **DIRECT** (Zéro Latence / Sans Proxy)

---

## 🌐 Infrastructure & Identité
*   **Serveur** : AWS Lightsail `63.34.0.38` (Région Irlande).
*   **Compte** : `proutmax` (V2).
*   **Wallet Signer** : Phantom (`0x3a80...`).
*   **Proxy Funder** : Safe Wallet (`0x6C8b...`).
*   **Sécurité** : L'accès direct est validé. Aucune IP de proxy nécessaire pour le moment.

---

## 🛠️ Commandes d'Urgence (SSH)

### 1. Relance Propre (Full Reset)
En cas de comportement erratique ou de blocage du solde :
```bash
pm2 restart polybot-v2 --update-env
```

### 2. Surveillance en Temps Réel
Pour voir les tirs et les deltas Binance :
```bash
pm2 logs polybot-v2 --lines 50
```

### 3. Diagnostic Réseau (Test Polymarket)
Si le bot n'arrive plus à se connecter :
```bash
curl -I https://clob.polymarket.com/health
```

---

## 💰 Gestion des Fonds & pUSD
*   **IMPORTANT** : Les fonds doivent être sur l'adresse **Proxy** (`0x6C8b...`) pour être visibles par le bot.
*   **Gaz** : Le wallet **Phantom** (`0x3a80...`) doit toujours avoir au moins **1 MATIC** pour signer les frais.
*   **Redeem** : Le bot effectue un auto-redeem après chaque session pour libérer les profits.

---

## 🚨 Procédure en cas de Ban
Si le bot affiche `address banned` :
1.  **Stop immédiat** : `pm2 stop polybot-v2`.
2.  **Nouveau Wallet** : Créer une nouvelle adresse Phantom.
3.  **Migration** : Mettre à jour `PRIVATE_KEY` et `CLOB_FUNDER_ADDRESS` dans le `.env`.
4.  **Restart**.

---
*Dernière mise à jour : 29 Avril 2026 - Migration V2 Stable Direct Mode.*
⚓🚀🏹
