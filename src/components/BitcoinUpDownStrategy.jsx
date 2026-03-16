import { useState, useEffect, useRef, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Label } from './ui/label';
import { useBitcoinUpDownSignals } from '../hooks/useBitcoinUpDownSignals';
import { useBitcoinUpDownResolved } from '../hooks/useBitcoinUpDownResolved';
import { useOrderBookLiquidity } from '../hooks/useOrderBookLiquidity';
import { useWallet } from '../context/useWallet';
import { placePolymarketOrder } from '../lib/polymarketOrder';

const inputClass =
  'flex h-10 w-full rounded-xl border border-input bg-background/50 px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50';

function formatMoney(value) {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

const BITCOIN_UP_DOWN_SLUG = 'bitcoin-up-or-down';
const STORAGE_KEY_LIQUIDITY_SUGGESTION = 'polymarket-dashboard.showLiquiditySuggestion';

/** Slug Polymarket du créneau Bitcoin Up or Down - Hourly pour l'heure actuelle (ET). */
function getCurrentBitcoinUpDownEventSlug() {
  const tz = 'America/New_York';
  const d = new Date();
  const month = d.toLocaleString('en-US', { timeZone: tz, month: 'long' }).toLowerCase();
  const day = parseInt(d.toLocaleString('en-US', { timeZone: tz, day: 'numeric' }), 10);
  const year = parseInt(d.toLocaleString('en-US', { timeZone: tz, year: 'numeric' }), 10);
  let hour = parseInt(d.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }), 10);
  const ampm = hour >= 12 ? 'pm' : 'am';
  hour = hour % 12 || 12;
  return `${BITCOIN_UP_DOWN_SLUG}-${month}-${day}-${year}-${hour}${ampm}-et`;
}

/** Point vert (Up) ou rouge (Down) comme sur Polymarket. */
function UpDownDot({ side, title = true }) {
  if (side !== 'Up' && side !== 'Down') return null;
  const isUp = side === 'Up';
  return (
    <span
      className={`inline-block w-3 h-3 rounded-full shrink-0 shadow-sm ring-2 ring-white/10 dark:ring-black/20 ${isUp ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-rose-500 dark:bg-rose-400'}`}
      title={title ? (isUp ? 'Up' : 'Down') : undefined}
      aria-label={isUp ? 'Up' : 'Down'}
    />
  );
}

export function BitcoinUpDownStrategy() {
  const { address, signer, status, errorMessage, isPolygon, connect, disconnect, switchToPolygon } = useWallet();
  const { signals } = useBitcoinUpDownSignals();
  const currentSignalTokenId = signals?.[0]?.tokenIdToBuy ?? null;
  const { liquidityUsd: liquidityAtTargetUsd, loading: liquidityLoading, error: liquidityError, refresh: refreshLiquidity } = useOrderBookLiquidity(currentSignalTokenId);
  const [extraDays, setExtraDays] = useState(0); // 0 = 3 jours, 1..4 = 4 à 7 jours
  const [includeFees, setIncludeFees] = useState(true);
  const resolvedWindowHours = 72 + extraDays * 24;
  const resolvedDaysCount = 3 + extraDays;
  const { resolved: resolvedHours, loading: resolvedLoading, error: resolvedError, refresh: refreshResolved } = useBitcoinUpDownResolved(resolvedWindowHours);
  const [orderSizeUsd] = useState(10);
  const [useMarketOrder] = useState(true);
  const [autoPlaceEnabled] = useState(true);
  const [, setPlacedOrderKeys] = useState(() => new Set());
  const placedOrderKeysRef = useRef(new Set());
  const [, setPlacingFor] = useState(null);
  const [, setPlaceResult] = useState(null);
  const autoPlaceInProgress = useRef(false);
  const [initialBalance, setInitialBalance] = useState(100);
  const [showLiquiditySuggestion, setShowLiquiditySuggestion] = useState(() => {
    if (typeof window === 'undefined') return true;
    try {
      const stored = localStorage.getItem(STORAGE_KEY_LIQUIDITY_SUGGESTION);
      if (stored === 'false') return false;
      if (stored === 'true') return true;
      return true;
    } catch {
      return true;
    }
  });

  const toggleShowLiquiditySuggestion = () => {
    setShowLiquiditySuggestion((v) => {
      const next = !v;
      try {
        localStorage.setItem(STORAGE_KEY_LIQUIDITY_SUGGESTION, String(next));
      } catch (_) {}
      return next;
    });
  };

  const backtestResult = useMemo(() => {
    const withSimul = resolvedHours.filter((r) => r.botWon !== null);
    const sortedSimul = [...withSimul].sort(
      (a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
    );
    const estimateCryptoTakerFeeUsd = (stakeUsd, p) => {
      if (!includeFees) return 0;
      if (stakeUsd <= 0 || p == null) return 0;
      const x = p * (1 - p);
      const feeRate = 0.25;
      const exponent = 2;
      return stakeUsd * feeRate * Math.pow(x, exponent);
    };
    let capital = initialBalance > 0 ? initialBalance : 0;
    let peak = capital;
    let maxDrawdown = 0;
    let feesPaid = 0;
    const netPnlMap = new Map();
    for (const r of sortedSimul) {
      if (capital <= 0) break;
      const stake = capital;
      const p = r.botEntryPrice != null ? Number(r.botEntryPrice) : null;
      const feeUsd = estimateCryptoTakerFeeUsd(stake, p);
      feesPaid += feeUsd;
      let delta = 0;
      if (p != null && r.botWon === true) {
        const odds = p > 0 ? 1 / p - 1 : 0;
        delta = stake * odds - feeUsd;
      } else if (r.botWon === false) {
        delta = -stake - feeUsd;
      }
      capital += delta;
      netPnlMap.set(`${r.eventSlug}-${r.endDate ?? ''}`, delta);
      if (capital > peak) peak = capital;
      const dd = peak > 0 ? (peak - capital) / peak : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    return {
      netPnlMap,
      capital,
      feesPaid,
      maxDrawdown,
      withSimul,
      won: withSimul.filter((r) => r.botWon === true).length,
    };
  }, [resolvedHours, initialBalance, includeFees]);

  const getSignalKey = (signal) => signal.market?.conditionId ?? signal.eventSlug ?? '';

  /** Règle : pas de trade si l’événement se termine dans moins d’une minute (ex. fin 18h → plus de trade à partir de 17h59). */
  const ONE_MINUTE_MS = 60 * 1000;
  const isInLastMinute = (signal) => {
    const raw = signal?.endDate;
    if (raw == null || raw === '') return false;
    let endMs;
    if (typeof raw === 'number') {
      endMs = raw > 1e12 ? raw : raw * 1000;
    } else {
      endMs = new Date(raw).getTime();
    }
    if (Number.isNaN(endMs)) return false;
    return Date.now() >= endMs - ONE_MINUTE_MS;
  };

  const placeOrderForSignal = async (signal, options = {}) => {
    if (!signer || !signal.tokenIdToBuy) return { error: 'Pas de signer ou token.' };
    if (isInLastMinute(signal)) {
      return { error: "Trop tard : l'événement se termine dans moins d'une minute." };
    }
    let sizeUsd = Number(orderSizeUsd) || 10;
    if (options.capUsd != null && options.capUsd > 0 && sizeUsd > options.capUsd) {
      sizeUsd = options.capUsd;
    }
    const price = signal.takeSide === 'Down' ? signal.priceDown : signal.priceUp;
    return placePolymarketOrder(signer, {
      tokenIdToBuy: signal.tokenIdToBuy,
      price,
      sizeUsd,
      useMarketOrder,
    });
  };

  const getCapUsdForSignal = (signal) => {
    if (!showLiquiditySuggestion || liquidityAtTargetUsd == null || liquidityAtTargetUsd <= 0) return null;
    if (signals?.[0] && getSignalKey(signal) === getSignalKey(signals[0])) return liquidityAtTargetUsd;
    return null;
  };

  const _handlePlaceOrder = async (signal) => {
    const key = getSignalKey(signal);
    setPlacingFor(key);
    setPlaceResult(null);
    if (isInLastMinute(signal)) {
      setPlaceResult({ key, error: "Trop tard : l'événement se termine dans moins d'une minute." });
      setPlacingFor(null);
      return;
    }
    const result = await placeOrderForSignal(signal, { capUsd: getCapUsdForSignal(signal) });
    setPlaceResult({ key, ...result });
    setPlacingFor(null);
  };

  // Le bot place l'ordre à ta place dès qu'un signal 96,8–97 % apparaît
  useEffect(() => {
    if (!autoPlaceEnabled || !signer || !address || !isPolygon || signals.length === 0 || autoPlaceInProgress.current) return;
    const toPlace = signals.filter(
      (s) => s.tokenIdToBuy && !placedOrderKeysRef.current.has(getSignalKey(s)) && !isInLastMinute(s)
    );
    if (toPlace.length === 0) return;
    autoPlaceInProgress.current = true;
    (async () => {
      for (const signal of toPlace) {
        if (isInLastMinute(signal)) continue;
        const key = getSignalKey(signal);
        placedOrderKeysRef.current.add(key);
        setPlacedOrderKeys((prev) => new Set([...prev, key]));
        setPlacingFor(key);
        const result = await placeOrderForSignal(signal, { capUsd: getCapUsdForSignal(signal) });
        setPlaceResult({ key, ...result });
        setPlacingFor(null);
        await new Promise((r) => setTimeout(r, 350));
      }
      autoPlaceInProgress.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isInLastMinute/placeOrderForSignal stables
  }, [autoPlaceEnabled, signer, address, isPolygon, signals, orderSizeUsd, useMarketOrder]);

  return (
    <div className="mx-auto max-w-2xl space-y-8 pb-12">
      <Card className="border border-border/60 bg-card/90 backdrop-blur-md shadow-xl shadow-black/10 rounded-2xl overflow-hidden">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-xl font-semibold tracking-tight">Stratégie Bitcoin Up or Down</CardTitle>
              <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                Signal 96,8–97 % sur les créneaux horaires Bitcoin Up or Down (Polymarket). Un pari par créneau, ordre limite, réinvestissement du solde — objectif environ 3 % par heure.
              </p>
              <a
                href={`https://polymarket.com/event/${getCurrentBitcoinUpDownEventSlug()}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 mt-3 text-sm font-medium text-primary hover:text-primary/90 hover:underline transition-colors"
              >
                Voir le créneau horaire actuel sur Polymarket
                <span className="text-muted-foreground">→</span>
              </a>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-8 pt-2">
          <div className="rounded-xl border border-border/40 bg-muted/5 p-5">
            <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
              <span className="w-1 h-4 rounded-full bg-primary/80" aria-hidden />
              Règles de la stratégie
            </h3>
            <ul className="text-sm text-muted-foreground space-y-2 list-none pl-0">
              <li className="flex gap-2.5"><span className="text-muted-foreground/60">•</span> Un seul pari par créneau horaire (bougie 1h BTC/USDT Binance).</li>
              <li className="flex gap-2.5"><span className="text-muted-foreground/60">•</span> Choisir Up ou Down selon ta lecture (tendance, support/résistance, ou valeur des cotes).</li>
              <li className="flex gap-2.5"><span className="text-muted-foreground/60">•</span> Miser une fraction du solde (ex. 80–100 % si tu veux « tout réinvestir »).</li>
              <li className="flex gap-2.5"><span className="text-muted-foreground/60">•</span> Après résolution : réinvestir tout le solde (capital + gains) sur le créneau suivant.</li>
              <li className="flex gap-2.5"><span className="text-muted-foreground/60">•</span> Signaux 96,8–97 % : on achète le <strong>favori</strong> (le côté à 96,8–97 %) pour viser au moins ~4 % de gain par trade (ex. achat à 95¢, gain 5¢ si ça gagne).</li>
              <li className="flex gap-2.5"><span className="text-muted-foreground/60">•</span> Utiliser le simulateur par heure ci-dessous pour projeter où tu peux arriver sur 24 h, 1 semaine, etc.</li>
            </ul>
            <div className="mt-3 pt-3 border-t border-border/40 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Afficher la taille max suggérée (liquidité à 97 %) :</span>
              <button
                type="button"
                onClick={toggleShowLiquiditySuggestion}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${showLiquiditySuggestion ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}
              >
                {showLiquiditySuggestion ? 'Activé' : 'Désactivé'}
              </button>
            </div>
          </div>

          {showLiquiditySuggestion && (currentSignalTokenId || liquidityAtTargetUsd != null) && (
            <div className="rounded-xl border border-border/50 bg-muted/10 p-4">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-2">
                <span className="w-1 h-4 rounded-full bg-primary/60" aria-hidden />
                Taille max suggérée (sans dégrader les gains)
              </h3>
              <p className="text-xs text-muted-foreground mb-2">
                Liquidité disponible à 96,8–97 % sur le créneau actuel. La mise est <strong>plafonnée automatiquement</strong> à ce montant (dashboard et bot) pour limiter le slippage.
              </p>
              {liquidityLoading ? (
                <span className="text-sm text-muted-foreground">Chargement du carnet…</span>
              ) : liquidityError ? (
                <span className="text-sm text-amber-600 dark:text-amber-400">{liquidityError}</span>
              ) : liquidityAtTargetUsd != null && liquidityAtTargetUsd > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">
                    ~{liquidityAtTargetUsd.toFixed(0)} $
                  </span>
                  <span className="text-sm text-muted-foreground">(taille max conseillée pour ce créneau)</span>
                  <button
                    type="button"
                    onClick={refreshLiquidity}
                    className="rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50"
                  >
                    Rafraîchir
                  </button>
                </div>
              ) : currentSignalTokenId ? (
                <span className="text-sm text-muted-foreground">Aucune liquidité à ≤97 % pour l’instant.</span>
              ) : null}
            </div>
          )}

          <div className="rounded-xl border border-border/50 bg-muted/10 p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <span className="w-1 h-4 rounded-full bg-primary/60" aria-hidden />
              Connexion wallet
            </h3>
            <p className="text-xs text-muted-foreground">
              Connecte ton wallet <strong>Phantom</strong> (ou MetaMask, etc.) sur <strong>Polygon</strong> pour que le bot puisse placer des ordres sur Polymarket. Les ordres sont signés par ton wallet, les fonds restent chez toi.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {!address ? (
                <>
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); connect(); }}
                    disabled={status === 'connecting'}
                    className="rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:active:scale-100"
                  >
                    {status === 'connecting' ? 'Connexion…' : 'Connecter le wallet'}
                  </button>
                  {errorMessage && (
                    <p className="w-full text-sm text-rose-500 dark:text-rose-400 mt-2" role="alert">
                      {errorMessage}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <span className="text-sm text-muted-foreground">
                    {address.slice(0, 6)}…{address.slice(-4)}
                  </span>
                  {!isPolygon && (
                    <button
                      type="button"
                      onClick={() => switchToPolygon()}
                      className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
                    >
                      Passer sur Polygon
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={disconnect}
                    className="rounded-xl border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
                  >
                    Déconnecter
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border/50 bg-muted/10 p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <span className="w-1 h-4 rounded-full bg-primary/60" aria-hidden />
              Résultats des heures passées
            </h3>
            <p className="text-xs text-muted-foreground">
              Créneaux Bitcoin Up or Down déjà résolus. Simulation « si le bot avait été actif » via l’historique des prix CLOB (96,8–97 %).
            </p>
            {resolvedError && <p className="text-sm text-red-500 dark:text-red-400">{resolvedError}</p>}
            {resolvedLoading ? (
              <p className="text-sm text-muted-foreground">Chargement…</p>
            ) : resolvedHours.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun créneau résolu sur les {resolvedDaysCount} derniers jours.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border/50">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Résultat</th>
                      <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Bot aurait pris</th>
                      <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Prix d&apos;entrée</th>
                      <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Heure trade</th>
                      <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Type</th>
                      <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Simul.</th>
                      <th className="text-right py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">PnL net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resolvedHours.map((r, i) => {
                      const rowKey = `${r.eventSlug}-${r.endDate ?? ''}`;
                      const netPnl = r.botWon !== null ? backtestResult.netPnlMap.get(rowKey) : undefined;
                      return (
                        <tr key={`${r.eventSlug}-${i}`} className={`border-b border-border/40 hover:bg-muted/20 transition-colors ${i % 2 === 1 ? 'bg-muted/5' : ''}`}>
                          <td className="py-3 px-3 font-medium">
                            {r.winner === 'Up' || r.winner === 'Down' ? <UpDownDot side={r.winner} /> : r.winner === null ? <span className="text-muted-foreground">En attente</span> : r.winner ?? '—'}
                          </td>
                          <td className="py-3 px-3 text-muted-foreground">
                            {r.botWouldTake != null ? <UpDownDot side={r.botWouldTake} /> : 'Données indisponibles'}
                          </td>
                          <td className="py-3 px-3">
                            {r.botEntryPrice != null ? `${(r.botEntryPrice * 100).toFixed(1)} %` : '—'}
                          </td>
                          <td className="py-3 px-3">
                            {r.botEntryTimestamp != null
                              ? new Date(r.botEntryTimestamp * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                              : '—'}
                          </td>
                          <td className="py-3 px-3">
                            {r.botOrderType ?? '—'}
                          </td>
                          <td className="py-3 px-3">
                            {r.botWon === true && <span className="font-medium text-emerald-600 dark:text-emerald-400">Gagné</span>}
                            {r.botWon === false && <span className="font-medium text-rose-600 dark:text-rose-400">Perdu</span>}
                            {r.botWon == null && (r.winner === null ? <span className="text-muted-foreground">En attente</span> : <span className="text-muted-foreground">Données indisponibles</span>)}
                          </td>
                          <td className="py-3 px-3 text-right font-medium tabular-nums">
                            {netPnl !== undefined
                              ? (
                                  <span className={netPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                                    {netPnl >= 0 ? '+' : ''}{formatMoney(netPnl)}
                                  </span>
                                )
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {resolvedHours.length > 0 && (() => {
              const { capital, feesPaid, maxDrawdown, withSimul, won } = backtestResult;
              const totalNetPnl = initialBalance > 0 ? capital - initialBalance : null;

              if (withSimul.length > 0) {
                return (
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                    <p>
                      Simulation : <strong>{won}</strong> gagnés / <strong>{withSimul.length}</strong> créneaux avec signal 96,8–97 %.
                    </p>
                    {initialBalance > 0 && (
                      <p>
                        Backtest avec solde initial <strong>{formatMoney(initialBalance)}</strong> : capital final{' '}
                        <strong>{formatMoney(capital)}</strong>{' '}
                        {capital > 0 && initialBalance > 0 && (
                          <span>
                            (
                            <span className={capital >= initialBalance ? 'text-emerald-500' : 'text-rose-500'}>
                              {(((capital - initialBalance) / initialBalance) * 100).toFixed(1)} %
                            </span>
                            )
                          </span>
                        )}
                        {totalNetPnl != null && (
                          <> · PnL net total <strong className={totalNetPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}>{totalNetPnl >= 0 ? '+' : ''}{formatMoney(totalNetPnl)}</strong></>
                        )}
                        {maxDrawdown > 0 && <> · drawdown max env. {(maxDrawdown * 100).toFixed(1)} %</>}
                        {includeFees && feesPaid > 0 && <> · frais estimés {formatMoney(feesPaid)}</>}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-muted-foreground">Backtest :</span>
                      <button
                        type="button"
                        onClick={() => setIncludeFees((v) => !v)}
                        className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                          includeFees ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                        }`}
                        title="Modèle simplifié de taker fees (crypto) basé sur la doc Polymarket"
                      >
                        {includeFees ? 'Frais ON' : 'Frais OFF'}
                      </button>
                      <span className="text-[11px] text-muted-foreground">
                        (estimation, le SDK gère les frais réels)
                      </span>
                    </div>
                  </div>
                );
              }
              return (
                <p className="text-xs text-muted-foreground mt-2">
                  Bot / Simul. : historique des prix CLOB indisponible pour ces créneaux (marchés résolus). Réessayer plus tard.
                </p>
              );
            })()}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <span className="text-xs text-muted-foreground mr-1">Affichage : {resolvedDaysCount} derniers jours</span>
              <button
                type="button"
                onClick={refreshResolved}
                disabled={resolvedLoading}
                className="rounded-xl border border-border px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50"
              >
                Rafraîchir
              </button>
              <button
                type="button"
                onClick={() => setExtraDays((d) => Math.min(4, d + 1))}
                disabled={resolvedLoading || extraDays >= 4}
                className="rounded-xl border border-border px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50"
              >
                Un jour de plus
              </button>
              <button
                type="button"
                onClick={() => setExtraDays((d) => Math.max(0, d - 1))}
                disabled={resolvedLoading || extraDays <= 0}
                className="rounded-xl border border-border px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50"
              >
                Un jour de moins
              </button>
            </div>
          </div>

          {resolvedHours.length > 0 && (() => {
            const last24h = resolvedHours.filter(
              (r) => r.endDate && new Date(r.endDate).getTime() >= Date.now() - 24 * 60 * 60 * 1000
            );
            const total24 = last24h.length;
            const withTrade24 = last24h.filter((r) => r.botEntryTimestamp != null).length;
            const pctFilled24 = total24 > 0 ? ((withTrade24 / total24) * 100).toFixed(1) : '0';
            const withEntry = resolvedHours.filter((r) => r.botEntryTimestamp != null && r.endDate);
            const sessionDurationSec = 3600;
            const minutesList = withEntry.map((r) => {
              const sessionEndSec = new Date(r.endDate).getTime() / 1000;
              const sessionStartSec = sessionEndSec - sessionDurationSec;
              return (r.botEntryTimestamp - sessionStartSec) / 60;
            });
            const avgMinutes = minutesList.length > 0 ? minutesList.reduce((a, b) => a + b, 0) / minutesList.length : 0;
            return (
              <div className="rounded-xl border border-border/50 bg-muted/10 p-5 space-y-2">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <span className="w-1 h-4 rounded-full bg-primary/60" aria-hidden />
                  Moyenne d&apos;entrée des trades
                </h3>
                <p className="text-sm text-muted-foreground">
                  Sur les <strong className="text-foreground">24 dernières heures</strong> : <strong className="text-primary">{pctFilled24} %</strong> des créneaux ont une position prise (<strong>{withTrade24}</strong> / {total24} créneaux). Le reste en données indisponibles.
                </p>
                {withEntry.length > 0 && (
                  <p className="text-sm text-muted-foreground">
                    Sur les <strong className="text-foreground">{withEntry.length}</strong> sessions affichées avec heure d&apos;entrée : le bot entre en moyenne à <strong className="text-primary">{avgMinutes.toFixed(1)} min</strong> après le début du créneau horaire.
                  </p>
                )}
              </div>
            );
          })()}

          <div className="rounded-xl border border-border/50 bg-muted/10 p-5 space-y-3">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <span className="w-1 h-4 rounded-full bg-primary/60" aria-hidden />
              Paramètres de session
            </h3>
            <p className="text-sm text-muted-foreground">
              Objectif : <strong className="text-primary">environ 3 % par heure</strong> (réinvestissement du solde à chaque créneau).
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1 min-w-[140px]">
                <Label htmlFor="strat-initial">Mise de départ (€)</Label>
                <input
                  id="strat-initial"
                  type="number"
                  min="0"
                  step="10"
                  value={initialBalance}
                  onChange={(e) => setInitialBalance(Number(e.target.value) || 0)}
                  className={`${inputClass} bg-white text-slate-900 placeholder:text-slate-500 dark:bg-slate-800 dark:text-white dark:placeholder:text-slate-400`}
                />
              </div>
              <p className="text-sm text-muted-foreground pb-2">
                Solde de départ : <strong className="text-primary">{formatMoney(initialBalance)}</strong>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
