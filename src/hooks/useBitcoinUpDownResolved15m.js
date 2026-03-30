import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  fetchBitcoin15mResolvedData,
  resolve15mSimConfig,
  DEFAULT_WINDOW_HOURS,
  BACKTEST_STOP_LOSS_TRIGGER_PRICE_P,
  BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT,
  BACKTEST_STOP_LOSS_DRAWDOWN_ENABLED,
  BACKTEST_STOP_LOSS_MIN_HOLD_SEC,
} from '@/lib/bitcoin15mResolvedDataFetch.js';
import { mergeBtcPmAugment } from '@/lib/mergeBtcPmAugment.js';

async function maybeMergeBtcPmAugment(rows) {
  const url = (import.meta.env.VITE_BACKTEST_15M_AUGMENT_JSON || '').trim();
  if (!url || !Array.isArray(rows) || rows.length === 0) return rows;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return rows;
    const doc = await r.json();
    return mergeBtcPmAugment(rows, doc);
  } catch {
    return rows;
  }
}

export {
  BACKTEST_STOP_LOSS_TRIGGER_PRICE_P,
  BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT,
  BACKTEST_STOP_LOSS_DRAWDOWN_ENABLED,
  BACKTEST_STOP_LOSS_MIN_HOLD_SEC,
};

/**
 * Récupère les marchés Bitcoin Up or Down 15 min résolus (slug btc-updown-15m-*).
 * @param {number} windowHours
 * @param {{ debug?: boolean }} [options] — `debug: true` : remplit `simDebug` par ligne + `debugSummary` (coût mémoire / logs).
 */
export function useBitcoinUpDownResolved15m(windowHours = DEFAULT_WINDOW_HOURS, options = {}) {
  const requestedDebug = Boolean(options.debug);
  const debug = requestedDebug && windowHours <= 96;
  /* eslint-disable react-hooks/exhaustive-deps -- resolve15mSimConfig(options) : seuils listés dans le tableau */
  const simCfg = useMemo(
    () => resolve15mSimConfig(options),
    [
      options?.simulation?.detectMinP,
      options?.simulation?.entryMinP,
      options?.simulation?.entryMaxP,
      options?.simulation?.stopLossTriggerPriceP,
      options?.simulation?.entryForbiddenFirstMin,
      options?.simulation?.entryForbiddenLastMin,
      options?.simConfig?.detectMinP,
      options?.simConfig?.entryMinP,
      options?.simConfig?.entryMaxP,
      options?.simConfig?.stopLossTriggerPriceP,
      options?.simConfig?.entryForbiddenFirstMin,
      options?.simConfig?.entryForbiddenLastMin,
      options?.simConfig?.signalMinDwellSec,
    ]
  );
  /* eslint-enable react-hooks/exhaustive-deps */
  const [resolved, setResolved] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [debugSummary, setDebugSummary] = useState(null);
  /** Dernière source ayant alimenté `resolved` : API live vs fichier JSON statique (pour l’UI et le debug SL). */
  const [dataSource, setDataSource] = useState(null);
  const fetchSeqRef = useRef(0);

  const fetchResolved = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    setError(null);
    setLoading(true);

    const liveOnly =
      import.meta.env.VITE_BACKTEST_15M_LIVE_ONLY === 'true' ||
      import.meta.env.VITE_BACKTEST_15M_LIVE_ONLY === '1';
    const staticUrl = liveOnly ? '' : (import.meta.env.VITE_BACKTEST_15M_STATIC_JSON || '').trim();
    if (staticUrl) {
      try {
        const r = await fetch(staticUrl, { cache: 'no-store' });
        if (r.ok) {
          const data = await r.json();
          const rows = data?.rows ?? data?.enrichedFinal;
          if (Array.isArray(rows) && rows.length > 0) {
            if (seq !== fetchSeqRef.current) return;
            setResolved(rows);
            setDebugSummary(data.debugSummary ?? null);
            setDataSource('static');
            setError(null);
            setLoading(false);
            return;
          }
        }
      } catch {
        /* repli sur le fetch live */
      }
    }

    try {
      const { enrichedFinal, debugSummary: sum } = await fetchBitcoin15mResolvedData(windowHours, simCfg, debug);
      if (seq !== fetchSeqRef.current) return;
      const merged = await maybeMergeBtcPmAugment(enrichedFinal);
      if (seq !== fetchSeqRef.current) return;
      setResolved(merged);
      setDebugSummary(debug ? sum : null);
      setDataSource('live');
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      setError(err.message || 'Erreur lors du chargement des résultats 15 min.');
      setResolved([]);
      setDataSource(null);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [windowHours, debug, simCfg]);

  useEffect(() => {
    fetchResolved();
  }, [fetchResolved]);

  return { resolved, loading, error, refresh: fetchResolved, debugSummary, dataSource };
}
