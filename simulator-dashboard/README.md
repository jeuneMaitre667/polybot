# Simulateur indépendant (non lié au dashboard principal)

Ce mini-dashboard est autonome dans `simulator-dashboard/` :

- pas de dépendance au code React existant,
- configurable (WR, SL, TP, prix d'entrée, frais, slippage, jours, trades/jour),
- Monte Carlo (distribution + percentiles).

## Lancer

Option la plus simple : ouvrir `simulator-dashboard/index.html` dans le navigateur.

Option serveur local (recommandé) :

```bash
npx serve simulator-dashboard
```

Puis ouvrir l'URL locale affichée.
