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

## 🛰️ Migration Polymarket V2 (v50.5.x)

### 3. Le Piège de l'Allowance V2 (Erreur 400)
- **Problème** : Les ordres de vente échouent avec une erreur "Allowance" alors que le wallet a du pUSD.
- **Cause** : Les approbations données pour le CTF Exchange V1 ne sont pas valables pour le nouveau contrat **CTF Exchange V2**.
- **Solution** : Implémenter un bouclier d'approbation automatique (`ensureV2Approvals`) au démarrage du bot pour vérifier et forcer l'allowance sur les adresses V2 (Standard & NegRisk).

### 4. La Sensibilité au Checksum Ethers
- **Problème** : Crash du bot lors de la vérification des adresses avec le message "bad address checksum".
- **Cause** : Ethers.js exige que les adresses contractuelles respectent une casse spécifique. Si une seule lettre change (majuscule/minuscule), l'appel échoue.
- **Solution** : Normaliser systématiquement les adresses : `ethers.utils.getAddress(addr.toLowerCase())`.

### 5. Suppression des Méthodes Obsolètes (V2 Incompatibility)
- **Problème** : Appels à des fonctions comme `getClobBalance()` ou `updateBalanceAllowance()` causant des plantages `undefined`.
- **Impact** : Ces méthodes ont été supprimées ou modifiées dans le SDK `clob-client-v2`.
- **Solution** : Synchroniser le solde via une boucle de reporting globale (`userBalance`) et utiliser les méthodes d'accès natives du SDK V2 (`getExchangeAddress`).

## 🛡️ Protocoles de Sécurité Futur
- Toujours vérifier le nombre de processus node.exe actifs via tasklist.
- Isoler les logs système au moindre signe de doublon.
- Utiliser un identifiant d'instance unique (PID) dans les notifications Telegram.
- **V2 Check** : S'assurer que le bouclier d'approbation affiche "Allowance OK" au démarrage.

### Problème de Doublons
- **Anomalie** : Deux instances du bot écrivant dans le même log et envoyant des messages Telegram concurrents.
- **Cause** : Processus orphelins ou tâches de persistance (type Daemon ou Service) non identifiées initialement.
- **Solution de Force** : Recours à l'option "Nucléaire" (taskkill /F /IM node.exe) et isolation des identifiants de processus dans les logs.

## 🛡️ Protocoles de Sécurité Futur
- Toujours vérifier le nombre de processus node.exe actifs via tasklist.
- Isoler les logs système au moindre signe de doublon.
- Utiliser un identifiant d'instance unique (PID) dans les notifications Telegram.
