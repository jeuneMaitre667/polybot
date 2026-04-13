#!/bin/bash
# Configure PM2 pour redémarrer les processus au boot de l'instance Lightsail.
# À exécuter une fois en SSH : ~/bot-24-7/pm2-startup.sh
# Puis exécuter la commande que PM2 affiche (sudo env PATH=... pm2 startup systemd ...).

set -e
cd ~/bot-24-7

echo "=== Vérification des processus PM2 ==="
pm2 list

echo ""
echo "=== Configuration du démarrage automatique au boot ==="
echo "Copie la commande ci-dessous (sudo env PATH=...) et exécute-la pour activer le démarrage au boot :"
echo ""
pm2 startup
