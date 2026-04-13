# Pipeline backtest BTC (Binance) + Polymarket (CLOB)

Objectif : enrichir les lignes du backtest 15m avec des horodatages **signal BTC** et **prix token PM** / **SL**, sans modifier l’UI du tableau. Les données sont attachées au champ **`btcPmAugment`** sur chaque ligne (fusion côté hook si `VITE_BACKTEST_15M_AUGMENT_JSON` est défini).

## Prérequis

1. Générer le cache dashboard : `npm run cache:15m` (produit `public/data/btc-15m-cache.json`).
2. Python 3.10+ et dépendances :

```bash
cd scripts/backtest_btc_pm
pip install -r requirements.txt
```

## Exécution

Depuis la racine du repo :

```bash
npm run backtest:btc-pm
```

Options utiles :

```bash
python scripts/backtest_btc_pm/pipeline.py --input public/data/btc-15m-cache.json --output public/data/btc-pm-augment.json
python scripts/backtest_btc_pm/pipeline.py --max-rows 30
```

Variables d’environnement (optionnel) :

| Variable | Défaut | Rôle |
|----------|--------|------|
| `SIGNAL_RULE` | `abs_delta` | `abs_delta` ( \|Δ%\| ), `up_move`, `down_move`, `range_pct` (range intraminute) |
| `SIGNAL_MIN_DELTA_PCT` | `0.01` | Seuil % selon la règle ci-dessus |
| `ENTRY_MIN_P` / `ENTRY_MAX_P` | `0.77` / `0.78` | Bande entrée PM (mid CLOB) |
| `SL_TRIGGER_P` | `0.60` | Seuil SL (comparé au mid ou au proxy bid) |
| `SL_BID_PROXY_FROM_MID` | `true` | Si `true`, détection SL sur **mid − offset** (comme le dashboard) |
| `SL_BID_OFFSET_P` | `0.007` | Offset mid → bid proxy |
| `MIN_HOLD_SEC` | `10` | Délai min avant test SL |

## Schéma JSON

Voir `schemas/btc-pm-augment.v1.schema.json` et l’exemple `public/data/btc-pm-augment.example.json`.

## Dashboard

Dans `.env` :

```env
VITE_BACKTEST_15M_AUGMENT_JSON=/data/btc-pm-augment.json
```

(redémarrer Vite). Les agrégats PnL / colonnes **Simul.** restent basés sur la simu JS existante ; `btcPmAugment` sert à comparer signal **BTC** vs remplissage **PM** (export, analyses, mode debug console).

## Limites

- Règle BTC **placeholder** : à remplacer par ta stratégie dans `pipeline.py` (`first_signal_btc`).
- SL sur **mid** CLOB, pas best bid — cohérent avec une première itération ; rapprocher du bot = proxy bid comme en JS.
- Rate limits Binance / Polymarket : pauses légères sur gros volumes ; réduire `--max-rows` pour tester.
