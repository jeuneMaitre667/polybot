# Polymarket V2 Sniper & Dashboard ⚓🚀

Système de trading algorithmique haute performance pour Polymarket V2, spécialisé sur les marchés Bitcoin Up/Down.

- **Dashboard V2** : Interface React (Vite) pour le monitoring temps réel, analyse de l'historique pUSD et calculateur d'intérêts composés.
- **Bot Sniper V2** : Moteur Node.js ultra-rapide sur AWS Lightsail (Irlande). Migration complète vers le protocole **pUSD** et CLOB V2.

## 🚀 Spécifications Techniques (Prod)

- **Infrastructure** : AWS Lightsail (IP: `63.34.0.38`) - Région `eu-west-1` (Bypass Geoblock).
- **Moteur** : Node.js 18+ | PM2 (Instance Unique: `polybot-v2`).
- **Stratégie Sniper** :
    - **Price Range** : `[0.88 - 0.95]` (Zone de probabilité optimale).
    - **Delta Threshold** : `0.07%` (Arbitrage de latence Binance vs Polymarket).
    - **Exit Logic** : Smart Orderbook Sweep (v48) - Sortie garantie au meilleur prix du carnet.
    - **Safety** : Anti-Glitch Shield (0.3% delta block) & Stop-Loss (-15%).

## 🛠️ Installation & Déploiement

### Dashboard
```bash
npm install
npm run dev
```

### Bot (Maintenance SSH)
Le bot tourne 24/7 sur Lightsail. Pour mettre à jour :
```bash
ssh -i "path/to/key.pem" ubuntu@63.34.0.38
cd ~/polybot/bot-24-7
git pull
pm2 restart polybot-v2
```

## 📂 Structure du Projet
- `src/` — Dashboard React (Monitoring & Analytics).
- `bot-24-7/` — Moteur de trading V2 (Signaux, CLOB, Risk Management).
- `règles IDE/` — Configuration et conventions pour l'assistant IA.

## ⚖️ Licence
Usage personnel uniquement.

