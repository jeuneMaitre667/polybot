# Résolution du problème de connectivité entre le bot et le dashboard

## Contexte

Le dashboard local affichait le bot en `offline` malgré un serveur de statut (`status-api`) qui répondait correctement sur Lightsail.

## Cause identifiée

Le serveur de statut utilisait une détection PM2 rigide pour un processus nommé `polymarket-bot`.

Sur Lightsail, le bot tournait sous un autre nom PM2 :

- `bot-modular`
- `bot-modular-v1`

Le serveur de statut ne reconnaissait donc pas le bot actif et renvoyait `status: offline`.

## Correction appliquée

1. Mise à jour de `bot-24-7/status-server.js` pour détecter plusieurs noms de processus PM2 :
   - `polymarket-bot`
   - `bot-modular`
   - `bot-modular-v1`

2. Ajout d'une logique de recherche de journaux (`pm2 logs`) pour essayer les mêmes noms dans l'ordre.

3. Redémarrage du service `status-api` sur le serveur Lightsail afin de prendre en compte la nouvelle logique.

## Résultat

Après correction :

- l’endpoint `http://localhost:3001/api/bot-status` sur Lightsail renvoie désormais `"status":"online"`
- le champ `pid` n’est plus `null`
- le dashboard peut afficher le bot correctement

## Recommandations futures

- Utiliser un nom PM2 cohérent et documenté pour le bot, idéalement `polymarket-bot`.
- Si le bot est déployé sous un autre nom, ajouter ce nom à la liste `BOT_PM2_NAMES` dans `bot-24-7/status-server.js`.
- Vérifier régulièrement `pm2 list` et `curl http://localhost:3001/api/bot-status` après un déploiement.
- Conserver la documentation de résolution dans `docs/bot-dashboard-connectivity-resolution.md`.
