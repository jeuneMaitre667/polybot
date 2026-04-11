# 🛡️ Polymarket Sniper: Troubleshooting & Incident Log

Ce document répertorie les incidents critiques rencontrés lors de la phase de stabilisation du Dashboard v17.15-v17.19 et leurs solutions définitives.

---

## 🛑 INCIDENT : Ghost Logs (Données Figées à 14h39)
**Symptôme** : Le Dashboard affiche des prix et une pipeline bloqués sur une heure précise (ex: 14h39) alors que l'horloge système avance.
- **Cause Racine** : Le `status-server.js` utilisait les fichiers `bot.log` et `decisions.log` comme "roue de secours" quand le fichier `health.json` était absent. Si le bot plantait, le serveur affichait la dernière ligne des logs historiques.
- **Solution** : 
    1. Troncature des logs physiques sur le serveur (`truncate -s 0 *.log`).
    2. Désactivation des fallbacks vers les logs bruts pour l'affichage temps-réel.
    3. Isolation des données de santé dans `health-v17.json`.

---

## 🛑 INCIDENT : Data Blackout (NaN / --- / Wallet Vide)
**Symptôme** : Le Dashboard affiche "ENGINE LIVE" mais toutes les valeurs sont à `NaN` ou `---`.
- **Cause Racine** : Mismatch de version. Le serveur faisait tourner une ancienne version de `index.js` alors que les corrections étaient appliquées sur `index.js.modular`. Le code actif ne générait jamais le fichier `health-v17.json` attendu par l'API.
- **Solution** : 
    1. Unification des fichiers : `index.js` est désormais une copie exacte de `index.js.modular`.
    2. Vérification systématique du poids du fichier `index.js` sur le serveur après déploiement.

---

## 🛑 INCIDENT : Dashboard Crash "toFixed"
**Symptôme** : Page noire avec l'erreur `Cannot read properties of undefined (reading 'toFixed')`.
- **Cause Racine** : Le React Dashboard essayait de formater des prix (Deltas, Strike) avant que le bot n'ait eu le temps de les calculer au démarrage (Pulse Initial).
- **Solution** : 
    1. Blindage de tous les appels `.toFixed()` dans le frontend.
    2. Utilisation systématique de `(value || 0).toFixed()` ou du chaînage optionnel `value?.toFixed()`.
    3. Ajout de valeurs de repli (fallbacks) comme `--` ou `0.00` dans les composants UI.

---

## 🛑 INCIDENT : Rupture du lien Bot-Dashboard
**Symptôme** : Le bot tourne (logs OK) mais le Dashboard reste en "Syncing Pulse" indéfiniment.
- **Cause Racine** : Utilisation de chemins relatifs (`process.cwd()`). Si le bot était lancé depuis un dossier parent ou via un script différent, le fichier `health-v17.json` était écrit dans un dossier inacessible par l'API.
- **Solution** : 
    1. Passage strict aux **chemins absolus** via `path.join(__dirname, '...')`.
    2. Synchronisation du dossier `BOT_DIR` dans `status-server.js` avec le dossier réel de déploiement.

---

## 💡 Recommandations de Maintenance
1. **Démarrage** : Toujours utiliser le port **5175** pour le Dashboard (évite le cache agressif du 5173).
2. **Déploiement** : Si une modification sur le Bot ne semble pas prise en compte, vérifier que `index.js` a bien été écrasé par la nouvelle version.
3. **Logs** : En cas de doute, la commande `tail -f bot.log` sur le serveur est le seul juge de paix pour vérifier l'activité réelle.
