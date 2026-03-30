#!/usr/bin/env python3
"""
Backtest BTC (Binance) + Polymarket CLOB — enrichissement aligné sur le cache dashboard.

Lit `public/data/btc-15m-cache.json` (ou --input), pour chaque ligne :
  - OHLCV 1m BTC/USDT (ccxt) sur le créneau 15m ;
  - prix CLOB `prices-history` pour token Up / Down ;
  - règle signal **placeholder** : premier minute où |Δ% vs open du créneau| ≥ seuil (env SIGNAL_MIN_DELTA_PCT, défaut 0.01) ;
  - entrée PM : premier point dans la bande [ENTRY_MIN_P, ENTRY_MAX_P] (défaut 0.77–0.78) sur le côté choisi ;
  - SL : premier instant après entrée où mid ≤ SL_P (défaut 0.60).

Sortie : JSON v1 consommé par le dashboard via VITE_BACKTEST_15M_AUGMENT_JSON (fusion champ `btcPmAugment`).

Usage :
  pip install -r requirements.txt
  python pipeline.py --input ../../public/data/btc-15m-cache.json --output ../../public/data/btc-pm-augment.json
  python pipeline.py --max-rows 20   # test rapide
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import requests

try:
    import ccxt
except ImportError:
    print("Installez les dépendances : pip install -r requirements.txt", file=sys.stderr)
    raise

CLOB_HISTORY = "https://clob.polymarket.com/prices-history"
SLOT_SEC = 15 * 60


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def fetch_binance_ohlcv_slot(
    exchange: ccxt.Exchange, slot_start_sec: int, slot_end_sec: int
) -> tuple[list[list[Any]] | None, str | None]:
    """1m bougies couvrant [slot_start, slot_end]."""
    since_ms = slot_start_sec * 1000
    try:
        # assez de bougies pour 15m + marge
        ohlcv = exchange.fetch_ohlcv(
            "BTC/USDT", "1m", since=since_ms, limit=32
        )
    except Exception as e:
        return None, str(e)
    if not ohlcv:
        return None, "empty_ohlcv"
    # garder bougies dont le timestamp (ms) est dans la fenêtre slot
    out = [
        c
        for c in ohlcv
        if slot_start_sec * 1000 <= c[0] <= slot_end_sec * 1000 + 60_000
    ]
    return (out if out else ohlcv, None)


def fetch_clob_history(token_id: str, start_ts: int, end_ts: int, fidelity: int = 1) -> tuple[list[dict[str, Any]], str | None]:
    params = {
        "market": token_id,
        "startTs": start_ts,
        "endTs": end_ts,
        "fidelity": fidelity,
    }
    try:
        r = requests.get(CLOB_HISTORY, params=params, timeout=25)
        r.raise_for_status()
        data = r.json()
        hist = data.get("history") or data if isinstance(data, list) else data.get("history", [])
        if not isinstance(hist, list):
            return [], "bad_shape"
        return hist, None
    except Exception as e:
        return [], str(e)


def normalize_p(p: float) -> float:
    if p > 1 and p <= 100:
        return p / 100.0
    return max(0.0, min(1.0, float(p)))


def _ref_open_from_ohlcv(ohlcv: list[list[Any]], slot_open_sec: int) -> tuple[float | None, int | None]:
    """Open du créneau = open de la première bougie 1m avec t >= slot_open_sec."""
    for c in ohlcv:
        t_sec = int(c[0] // 1000)
        if t_sec >= slot_open_sec:
            return float(c[1]), t_sec
    return None, None


def first_signal_btc(
    ohlcv: list[list[Any]], slot_open_sec: int, threshold_pct: float, rule: str
) -> tuple[int | None, dict[str, Any], str]:
    """
    Règles (env SIGNAL_RULE) :
      - abs_delta : |close - ref| / ref * 100 ≥ threshold (défaut, mouvement notable dans l’un ou l’autre sens)
      - up_move   : (close - ref) / ref * 100 ≥ threshold (BTC monte vs open du créneau)
      - down_move : (close - ref) / ref * 100 ≤ -threshold
      - range_pct : (high - low) / ref * 100 ≥ threshold sur au moins une bougie (range intraminute)
    """
    if not ohlcv:
        return None, {}, "abs_delta"
    ref_open, ref_t = _ref_open_from_ohlcv(ohlcv, slot_open_sec)
    if ref_open is None or ref_open <= 0:
        return None, {"reason": "no_ref_open"}, rule

    base = {
        "thresholdPct": threshold_pct,
        "refOpenUsd": ref_open,
        "refFromSec": ref_t,
        "rule": rule,
    }

    if rule == "up_move":
        for c in ohlcv:
            t_sec = int(c[0] // 1000)
            close = float(c[4])
            delta_pct = (close - ref_open) / ref_open * 100.0
            if delta_pct >= threshold_pct:
                return t_sec, {**base, "deltaPctFromOpen": round(delta_pct, 6)}, rule
        return None, {**base, "reason": "below_threshold_up"}, rule

    if rule == "down_move":
        for c in ohlcv:
            t_sec = int(c[0] // 1000)
            close = float(c[4])
            delta_pct = (close - ref_open) / ref_open * 100.0
            if delta_pct <= -threshold_pct:
                return t_sec, {**base, "deltaPctFromOpen": round(delta_pct, 6)}, rule
        return None, {**base, "reason": "below_threshold_down"}, rule

    if rule == "range_pct":
        for c in ohlcv:
            t_sec = int(c[0] // 1000)
            high = float(c[2])
            low = float(c[3])
            range_pct = (high - low) / ref_open * 100.0
            if range_pct >= threshold_pct:
                return t_sec, {**base, "rangePct": round(range_pct, 6), "candleHigh": high, "candleLow": low}, rule
        return None, {**base, "reason": "below_range_threshold"}, rule

    # abs_delta (défaut)
    for c in ohlcv:
        t_sec = int(c[0] // 1000)
        close = float(c[4])
        delta_pct = abs(close - ref_open) / ref_open * 100.0
        if delta_pct >= threshold_pct:
            return t_sec, {**base, "deltaPctFromOpen": round(delta_pct, 6)}, rule
    return None, {**base, "reason": "below_threshold", "refOpenUsd": ref_open}, rule


def points_in_band(
    history: list[dict[str, Any]], lo: float, hi: float, side: str
) -> list[tuple[int, float, str]]:
    """Liste (t_sec, price, side Up|Down) pour points dans [lo,hi]."""
    out: list[tuple[int, float, str]] = []
    for pt in history:
        t = pt.get("t") or pt.get("timestamp")
        p = pt.get("p") or pt.get("price")
        if t is None or p is None:
            continue
        ts = int(t) if int(t) < 10**12 else int(t) // 1000
        price = normalize_p(float(p))
        if lo <= price <= hi:
            out.append((ts, price, side))
    out.sort(key=lambda x: x[0])
    return out


def mid_to_sl_price(mid_p: float, use_bid_proxy: bool, offset_p: float) -> float:
    """Aligné backtest JS : proxy bid ≈ mid − offset (défaut 0,007)."""
    if not use_bid_proxy:
        return mid_p
    return max(0.001, min(0.99, mid_p - offset_p))


def walk_sl(
    history_held: list[dict[str, Any]],
    entry_sec: int,
    entry_price: float,
    sl_p: float,
    min_hold_sec: float,
    use_bid_proxy: bool,
    bid_offset_p: float,
) -> tuple[bool, int | None, float | None]:
    """Premier t ≥ entry + min_hold où prix de détection SL ≤ sl_p (mid ou proxy bid)."""
    hold_end = entry_sec + int(min_hold_sec)
    pts = []
    for pt in history_held:
        t = pt.get("t") or pt.get("timestamp")
        p = pt.get("p") or pt.get("price")
        if t is None or p is None:
            continue
        ts = int(t) if int(t) < 10**12 else int(t) // 1000
        mid = normalize_p(float(p))
        det = mid_to_sl_price(mid, use_bid_proxy, bid_offset_p)
        pts.append((ts, det))
    pts.sort(key=lambda x: x[0])
    for ts, det_p in pts:
        if ts < hold_end:
            continue
        if det_p <= sl_p:
            return True, ts, det_p
    return False, None, None


def process_row(
    row: dict[str, Any],
    exchange: ccxt.Exchange,
    env: dict[str, str],
) -> dict[str, Any]:
    slot_end = row.get("slotEndSec")
    if slot_end is None:
        return {
            "slotEndSec": None,
            "conditionId": row.get("conditionId"),
            "sources": {
                "binanceBtc": {"status": "skipped", "errorMessage": "no_slotEndSec"},
                "polymarketClob": {"status": "skipped", "errorMessage": "no_slotEndSec"},
            },
        }
    slot_end = int(slot_end)
    slot_start = slot_end - SLOT_SEC
    cid = row.get("normalizedConditionId") or row.get("conditionId")
    token_up = row.get("tokenIdUp")
    token_down = row.get("tokenIdDown")

    lo = float(env.get("ENTRY_MIN_P", "0.77"))
    hi = float(env.get("ENTRY_MAX_P", "0.78"))
    sl_p = float(env.get("SL_TRIGGER_P", "0.60"))
    min_hold = float(env.get("MIN_HOLD_SEC", "10"))
    sig_pct = float(env.get("SIGNAL_MIN_DELTA_PCT", "0.01"))
    signal_rule = (env.get("SIGNAL_RULE") or "abs_delta").strip().lower()
    if signal_rule not in ("abs_delta", "up_move", "down_move", "range_pct"):
        signal_rule = "abs_delta"
    use_bid_proxy = (env.get("SL_BID_PROXY_FROM_MID") or "true").lower() in ("1", "true", "yes")
    bid_offset_p = float(env.get("SL_BID_OFFSET_P", "0.007"))

    ohlcv, err_b = fetch_binance_ohlcv_slot(exchange, slot_start, slot_end)
    src_btc: dict[str, Any] = {"status": "ok", "errorMessage": None, "detail": {}}
    btc_block: dict[str, Any] = {
        "slotOpenPriceUsd": None,
        "signalRuleId": signal_rule,
        "signalTriggeredAtSec": None,
        "signalDetails": {},
    }
    if err_b:
        src_btc = {"status": "error", "errorMessage": err_b, "detail": {}}
    elif ohlcv:
        src_btc["detail"] = {"candles1m": len(ohlcv), "signalRule": signal_rule}
        sig_t, det, _rid = first_signal_btc(ohlcv, slot_start, sig_pct, signal_rule)
        btc_block["signalTriggeredAtSec"] = sig_t
        btc_block["signalDetails"] = det
        if det.get("refOpenUsd") is not None:
            btc_block["slotOpenPriceUsd"] = det.get("refOpenUsd")
    else:
        src_btc = {"status": "error", "errorMessage": "no_ohlcv", "detail": {}}

    pm_up: list[dict[str, Any]] = []
    pm_down: list[dict[str, Any]] = []
    err_u = err_d = None
    if token_up:
        pm_up, err_u = fetch_clob_history(str(token_up), slot_start - 1800, slot_end + 2700, 1)
    if token_down:
        pm_down, err_d = fetch_clob_history(str(token_down), slot_start - 1800, slot_end + 2700, 1)

    src_pm: dict[str, Any] = {
        "status": "ok",
        "errorMessage": None,
        "detail": {
            "fidelityMin": 1,
            "pointsUp": len(pm_up),
            "pointsDown": len(pm_down),
        },
    }
    if err_u or err_d:
        src_pm["status"] = "error"
        src_pm["errorMessage"] = err_u or err_d

    in_up = points_in_band(pm_up, lo, hi, "Up")
    in_down = points_in_band(pm_down, lo, hi, "Down")
    merged: list[tuple[int, float, str]] = []
    for ts, p, _ in in_up:
        merged.append((ts, p, "Up"))
    for ts, p, _ in in_down:
        merged.append((ts, p, "Down"))
    merged.sort(key=lambda x: x[0])

    pm_block: dict[str, Any] = {
        "entrySide": None,
        "entryPriceP": None,
        "entryAtSec": None,
        "seriesUsed": "clob_mid",
    }
    sl_block: dict[str, Any] = {
        "triggerPriceP": sl_p,
        "touched": None,
        "touchedAtSec": None,
        "detectionMode": "bid_proxy" if use_bid_proxy else "mid",
        "bidProxyOffsetP": bid_offset_p if use_bid_proxy else None,
        "observedPriceAtSlP": None,
    }

    if merged:
        ts_e, price_e, side_e = merged[0]
        # fenêtre stricte créneau [slot_start, slot_end] pour l’entrée affichée
        if slot_start <= ts_e <= slot_end + 45 * 60:
            pm_block["entrySide"] = side_e
            pm_block["entryPriceP"] = round(price_e, 4)
            pm_block["entryAtSec"] = ts_e
            held = pm_up if side_e == "Up" else pm_down
            touched, t_sl, obs_sl = walk_sl(
                held, ts_e, price_e, sl_p, min_hold, use_bid_proxy, bid_offset_p
            )
            sl_block["touched"] = touched
            sl_block["touchedAtSec"] = t_sl
            if obs_sl is not None:
                sl_block["observedPriceAtSlP"] = round(obs_sl, 6)

    partial = src_btc["status"] != "ok" or src_pm["status"] != "ok"
    return {
        "slotEndSec": slot_end,
        "conditionId": cid,
        "eventSlug": row.get("eventSlug"),
        "sources": {"binanceBtc": src_btc, "polymarketClob": src_pm},
        "btc": btc_block,
        "pm": pm_block,
        "sl": sl_block,
        "flags": {
            "usableForPnl": not partial and pm_block["entryAtSec"] is not None,
            "partialData": partial,
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Pipeline BTC Binance + PM CLOB augment v1")
    ap.add_argument(
        "--input",
        type=Path,
        default=Path(__file__).resolve().parent.parent.parent / "public" / "data" / "btc-15m-cache.json",
    )
    ap.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent.parent.parent / "public" / "data" / "btc-pm-augment.json",
    )
    ap.add_argument("--max-rows", type=int, default=0, help="0 = toutes les lignes")
    args = ap.parse_args()

    env = {k: v for k, v in os.environ.items()}

    if not args.input.is_file():
        print(f"Fichier introuvable : {args.input} (lancez npm run cache:15m d'abord)", file=sys.stderr)
        return 1

    data = load_json(args.input)
    rows = data.get("rows") or data.get("enrichedFinal") or []
    if not isinstance(rows, list):
        print("JSON : attendu data.rows ou enrichedFinal", file=sys.stderr)
        return 1

    if args.max_rows > 0:
        rows = rows[: args.max_rows]

    exchange = ccxt.binance({"enableRateLimit": True})
    items: list[dict[str, Any]] = []
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        item = process_row(row, exchange, env)
        items.append(item)
        if (i + 1) % 20 == 0:
            time.sleep(exchange.rateLimit / 1000.0)

    out_doc = {
        "schemaVersion": "1",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "pipeline": {
            "name": "backtest_btc_pm",
            "version": "1",
            "inputCachePath": str(args.input.as_posix()),
        },
        "items": items,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        json.dump(out_doc, f, ensure_ascii=False, indent=2)
    print(f"Écrit {args.output} ({len(items)} items)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
