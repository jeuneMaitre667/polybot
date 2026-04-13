# Audit : Leçons Apprises (Industrialisation v17.62.0)

Ce document répertorie les erreurs critiques identifiées lors des phases de stabilisation du Polymarket Sniper Bot.

## 🔴 Erreurs Techniques

### 1. Le Bug du Retour Chariot Windows (\r)
- **Problème** : Les variables d'environnement (.env) éditées sous Windows contiennent un caractère invisible \r.
- **Impact** : SIMULATION_TRADE_ENABLED=true\r n'est pas égal à true, causant le basculement forcé en mode Réel et l'affichage du solde Polygon réel (3.13$).
- **Solution** : Utiliser .trim() systématiquement sur les variables d'environnement lors de l'import.

### 2. Suppression de la Variable Globale mv
- **Problème** : Lors de la restructuration du bloc Heartbeat, la définition de mv (Market View) a été accidentellement supprimée.
- **Impact** : Crash silencieux de la boucle principale à chaque cycle, bloquant l'analyse de marché et le trading.
- **Solution** : Rétablissement de const mv = marketState; et monitoring des logs PM2 pour les erreurs de type undefined.

## 👻 Le Sniper Fantôme (Persistance Windows)

### Problème de Doublons
- **Anomalie** : Deux instances du bot écrivant dans le même log et envoyant des messages Telegram concurrents.
- **Cause** : Processus orphelins ou tâches de persistance (type Daemon ou Service) non identifiées initialement.
- **Solution de Force** : Recours à l'option "Nucléaire" (taskkill /F /IM node.exe) et isolation des identifiants de processus dans les logs.

## 🛡️ Protocoles de Sécurité Futur
- Toujours vérifier le nombre de processus node.exe actifs via tasklist.
- Isoler les logs système au moindre signe de doublon.
- Utiliser un identifiant d'instance unique (PID) dans les notifications Telegram.
