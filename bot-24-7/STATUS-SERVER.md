# Serveur de statut du bot (optionnel)

Pour afficher le statut du bot et les derniers logs dans le dashboard :

1. **Sur Lightsail (SSH)** : lancer le serveur de statut avec PM2 :
   ```bash
   cd ~/bot-24-7
   pm2 start status-server.js --name bot-status-server
   pm2 save
   ```

2. **Ouvrir le port 3001** : dans la console AWS Lightsail → ton instance → onglet **Réseau** → ajouter une règle (TCP, port 3001).

3. **Dans le projet dashboard** : créer un fichier `.env` à la racine avec :
   ```
   VITE_BOT_STATUS_URL=http://TON_IP_LIGHTSAIL:3001
   ```
(remplacer TON_IP_LIGHTSAIL par l’IP publique de l’instance, ex. 34.253.136.19)

4. Redémarrer le dashboard (`npm run dev`) pour que la section « Statut du bot » interroge ce serveur.

Optionnel : pour protéger l’accès, définir `BOT_STATUS_SECRET` dans `~/bot-24-7/.env` sur le serveur, puis ajouter `?token=TA_SECRET` à l’URL dans le dashboard (ou gérer le token côté front si tu l’implémentes).
