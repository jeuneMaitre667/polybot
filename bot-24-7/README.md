# Bot Polymarket 24/7 — Bitcoin Up or Down

Script Node.js pour faire tourner le bot en continu sur un VPS : surveillance des signaux 96,8–97 %, règle « pas de trade dans la dernière minute », placement d’ordres sur le CLOB Polymarket.

## Prérequis

- Node.js 18+
- Un wallet Polygon dédié au bot (avec un peu de USDC et de MATIC pour le gas)
- Clé privée de ce wallet (à ne jamais commiter)

## Installation sur le VPS

```bash
cd bot-24-7
npm install
cp .env.example .env
# Éditer .env : PRIVATE_KEY=0x...
npm start
```

## Variables d’environnement (.env)

| Variable | Description | Défaut |
|----------|-------------|--------|
| `PRIVATE_KEY` | Clé privée du wallet (hex, avec ou sans 0x) | requis |
| `POLYGON_RPC_URL` | RPC Polygon | `https://polygon-rpc.com` |
| `ORDER_SIZE_USD` | Montant par ordre en USDC | 10 |
| `USE_MARKET_ORDER` | `true` = marché, `false` = limite | true |
| `POLL_INTERVAL_SEC` | Intervalle de surveillance (secondes) | 10 |

## Lancer en arrière-plan (PM2)

Sur le VPS, pour que le script redémarre après un crash et survive à la déconnexion SSH :

```bash
npm install -g pm2
pm2 start index.js --name polymarket-bot
pm2 save
pm2 startup   # à exécuter une fois (suit les instructions)
```

Commandes utiles : `pm2 logs polymarket-bot`, `pm2 restart polymarket-bot`, `pm2 stop polymarket-bot`.

**Démarrage au boot** : exécuter une fois `~/bot-24-7/pm2-startup.sh` puis la commande `sudo env PATH=... pm2 startup systemd ...` affichée par PM2 pour que le bot (et le serveur de statut si utilisé) redémarre après un reboot.

**Sauvegarde de la config (sans la clé)** : `~/bot-24-7/backup-env.sh` crée `.env.backup.redacted` avec `PRIVATE_KEY` masquée ; à stocker ailleurs. La vraie clé reste à sauvegarder séparément (ex. coffre-fort).

**Serveur de statut (optionnel)** : voir `STATUS-SERVER.md` pour exposer statut et logs au dashboard.

**Alerte si le bot plante** : configurer `ALERT_DISCORD_WEBHOOK_URL` ou `ALERT_TELEGRAM_*` dans `.env`, puis mettre en cron : `*/5 * * * * bash ~/bot-24-7/check-bot-health.sh` (toutes les 5 min).

## Hébergement VPS — région autorisée + latence minimale

Polymarket **bloque le placement d’ordres** depuis certaines IP (pays/régions). Les ordres depuis une région bloquée sont **rejetés**. Référence officielle : [Geographic Restrictions – Polymarket](https://docs.polymarket.com/api-reference/geoblock#blocked-countries).

### Pays bloqués (ordre refusé)

D’après la [doc](https://docs.polymarket.com/api-reference/geoblock#blocked-countries) : AU, BE, BY, BI, CF, CD, CU, DE, ET, FR, GB, IR, IQ, IT, KP, LB, LY, MM, NI, NL, RU, SG (close-only), SO, SS, SD, SY, TH (close-only), TW (close-only), UM, **US**, VE, YE, ZW.  
Régions bloquées : Canada Ontario (ON), Ukraine (Crimea, Donetsk, Luhansk).

Donc **pas de VPS aux USA**, en France, Allemagne, UK, Pays-Bas, Australie, etc. pour pouvoir placer des ordres.

### Infra Polymarket et région recommandée

La doc indique : **Primary Servers** = `eu-west-2`, **Closest Non-Georestricted Region** = `eu-west-1`. Donc la meilleure région pour latence tout en restant autorisée est **eu-west-1** (ex. Irlande).

### Recommandation : VPS en **eu-west-1** (Irlande ou proche)

| Fournisseur | Région à choisir | Prix indicatif | Lien |
|-------------|------------------|----------------|------|
| **AWS Lightsail** | **eu-west-1** (Ireland) | ~3,50 €/mois | [aws.amazon.com/lightsail](https://aws.amazon.com/lightsail) |
| **DigitalOcean** | Vérifier une région dans un pays **non bloqué** (ex. Espagne si dispo) | ~5 €/mois | [digitalocean.com](https://www.digitalocean.com) |
| **Hetzner** | **Helsinki** (Finlande, FI) | ~4 €/mois | [hetzner.com](https://www.hetzner.com) |

- **Meilleur compromis** : **AWS Lightsail eu-west-1 (Ireland)** — région indiquée comme la plus proche non géorestricted.
- Vérifier avant déploiement : `GET https://polymarket.com/api/geoblock` depuis l’IP du VPS ; si `blocked: false`, tu peux trader.

## Ce qui peut bloquer le bot en live

| Cause | Symptôme / message | À faire |
|-------|--------------------|--------|
| **Géobloc** | Ordres rejetés, IP dans un pays bloqué | VPS dans une région [non bloquée](https://docs.polymarket.com/api-reference/geoblock#blocked-countries). Au démarrage le bot appelle `GET https://polymarket.com/api/geoblock` ; si `blocked: true`, il refuse de lancer. |
| **Wallet / auth** | `Invalid api key`, `order signer address has to be the address of the API KEY` | La clé privée doit être celle du wallet qui place l’ordre. L’API key CLOB est dérivée de cette clé ; ne pas mélanger plusieurs wallets. |
| **Adresse restreinte** | `address banned` ou `address in closed only mode` | Compte Polymarket restreint (close-only ou banni). Utiliser un autre wallet ou contacter [Polymarket Support](https://polymarket.com/support). |
| **Solde insuffisant** | Échec au placement (USDC ou MATIC) | Wallet Polygon : assez de **USDC** pour la taille d’ordre + un peu de **MATIC** pour le gas. Vérifier les soldes avant de lancer. |
| **Rate limit (429)** | `Too Many Requests` | Le CLOB limite les requêtes (ex. [Rate Limits](https://docs.polymarket.com/api-reference/rate-limits)). Le bot fait un retry avec backoff ; garder `POLL_INTERVAL_SEC` ≥ 10 et éviter de lancer plusieurs bots sur le même compte. |
| **Trading désactivé** | `Trading is currently disabled` ou `cancel-only` | Dépannage côté Polymarket ; réessayer plus tard. |
| **RPC Polygon** | Timeouts, pas de connexion | Changer `POLYGON_RPC_URL` (ex. un autre RPC public ou Alchemy/Infura). |
| **Crash / redémarrage** | Le processus s’arrête | Lancer avec **PM2** (`pm2 start index.js --name polymarket-bot` + `pm2 startup`) pour redémarrage auto. |

## Recommandations (d’après la doc Polymarket) pour que les trades passent bien

1. **Vérifier le géobloc au démarrage** — [Geographic Restrictions](https://docs.polymarket.com/api-reference/geoblock) : appeler `GET https://polymarket.com/api/geoblock` et ne pas placer d’ordres si `blocked: true`. Le script le fait au lancement.
2. **Rate limits** — [Rate Limits](https://docs.polymarket.com/api-reference/rate-limits) : ne pas dépasser les limites (ex. burst 3 500 req/10s pour POST /order). Rester à un poll ≥ 10 s et un seul ordre à la fois ; en cas de 429, utiliser un retry avec backoff (le script le fait).
3. **Auth** — [Authentication](https://docs.polymarket.com/api-reference/authentication) : utiliser le SDK (`createOrDeriveApiKey`) pour dériver les credentials depuis la clé privée ; le maker/signer doit être l’adresse du wallet. Le script utilise déjà `ClobClient` + wallet ethers.
4. **Erreurs courantes** — [Error Codes](https://docs.polymarket.com/resources/error-codes) : en cas de rejet, vérifier `Invalid order payload`, `address banned`, `closed only mode`, etc. Les messages d’erreur du script reprennent la réponse CLOB.

En résumé : **VPS autorisé (geoblock)** + **wallet dédié avec USDC/MATIC** + **poll raisonnable et retry sur 429** + **PM2 pour la persistance**.

## Sécurité

- Utilise un **wallet dédié** au bot, avec uniquement les fonds nécessaires.
- Ne commite **jamais** la clé privée ; garde-la dans `.env` (et ajoute `.env` dans `.gitignore`).
- Sur le VPS : `chmod 600 .env` et exécute le script avec un utilisateur non root si possible.
