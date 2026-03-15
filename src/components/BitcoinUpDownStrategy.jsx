import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Label } from './ui/label';
import { useBitcoinUpDownSignals } from '../hooks/useBitcoinUpDownSignals';
import { useBitcoinUpDownResolved } from '../hooks/useBitcoinUpDownResolved';
import { useWallet } from '../context/WalletContext';
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
  const { signals, loading: signalsLoading, error: signalsError, refresh: refreshSignals } = useBitcoinUpDownSignals();
  const [extraDays, setExtraDays] = useState(0); // 0 = 3 jours, 1..4 = 4 à 7 jours
  const resolvedWindowHours = 72 + extraDays * 24;
  const resolvedDaysCount = 3 + extraDays;
  const { resolved: resolvedHours, loading: resolvedLoading, error: resolvedError, refresh: refreshResolved } = useBitcoinUpDownResolved(resolvedWindowHours);
  const [orderSizeUsd, setOrderSizeUsd] = useState(10);
  const [useMarketOrder, setUseMarketOrder] = useState(true);
  const [autoPlaceEnabled, setAutoPlaceEnabled] = useState(true);
  const [placedOrderKeys, setPlacedOrderKeys] = useState(() => new Set());
  const placedOrderKeysRef = useRef(new Set());
  const [placingFor, setPlacingFor] = useState(null);
  const [placeResult, setPlaceResult] = useState(null);
  const autoPlaceInProgress = useRef(false);
  const [initialBalance, setInitialBalance] = useState(100);

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

  const placeOrderForSignal = async (signal) => {
    if (!signer || !signal.tokenIdToBuy) return { error: 'Pas de signer ou token.' };
    if (isInLastMinute(signal)) {
      return { error: "Trop tard : l'événement se termine dans moins d'une minute." };
    }
    const price = signal.takeSide === 'Down' ? signal.priceDown : signal.priceUp;
    return placePolymarketOrder(signer, {
      tokenIdToBuy: signal.tokenIdToBuy,
      price,
      sizeUsd: Number(orderSizeUsd) || 10,
      useMarketOrder,
    });
  };

  const handlePlaceOrder = async (signal) => {
    const key = getSignalKey(signal);
    setPlacingFor(key);
    setPlaceResult(null);
    if (isInLastMinute(signal)) {
      setPlaceResult({ key, error: "Trop tard : l'événement se termine dans moins d'une minute." });
      setPlacingFor(null);
      return;
    }
    const result = await placeOrderForSignal(signal);
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
        const result = await placeOrderForSignal(signal);
        setPlaceResult({ key, ...result });
        setPlacingFor(null);
        await new Promise((r) => setTimeout(r, 800));
      }
      autoPlaceInProgress.current = false;
    })();
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
                href="https://polymarket.com/search?q=bitcoin+up+or+down"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 mt-3 text-sm font-medium text-primary hover:text-primary/90 hover:underline transition-colors"
              >
                Voir les créneaux horaires sur Polymarket
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
              <li className="flex gap-2.5"><span className="text-muted-foreground/60">•</span> Signaux 96,8–97 % : on achète le <strong>favori</strong> (le côté à 96,8–97 %) pour viser au moins ~4 % de gain par trade (ex. achat à 95¢, gain 5¢ si ça gagne).</li>
              <li className="flex gap-2.5"><span className="text-muted-foreground/60">•</span> Utiliser le simulateur par heure ci-dessous pour projeter où tu peux arriver sur 24 h, 1 semaine, etc.</li>
            </ul>
          </div>

          <div className="rounded-xl border border-border/50 bg-muted/10 p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <span className="w-1 h-4 rounded-full bg-primary/60" aria-hidden />
              Connexion wallet
            </h3>
            <p className="text-xs text-muted-foreground">
              Connecte ton wallet (MetaMask, etc.) sur <strong>Polygon</strong> pour que le bot puisse placer des ordres sur Polymarket. Les ordres sont signés par ton wallet, les fonds restent chez toi.
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

          <div className="rounded-xl border border-primary/20 bg-gradient-to-br from-primary/5 to-primary/10 p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <span className="w-1 h-4 rounded-full bg-primary" aria-hidden />
              Signaux 96,8–97 %
            </h3>
            <p className="text-xs text-muted-foreground">
              Uniquement sur les marchés <strong>Bitcoin Up or Down - Hourly</strong>. On achète le côté à 96,8–97 % (le favori) pour viser au moins ~4 % de gain (ex. acheter à 95¢, toucher 1 $). Active « Le bot place l’ordre à ma place » (wallet connecté sur Polygon) pour que le bot envoie l’ordre automatiquement. Rafraîchissement ~10 s.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <label className={`flex items-center gap-2 text-sm ${address && isPolygon ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'}`}>
                <input
                  type="checkbox"
                  checked={autoPlaceEnabled}
                  onChange={(e) => setAutoPlaceEnabled(e.target.checked)}
                  disabled={!address || !isPolygon}
                  className="rounded border-input"
                />
                <span>Le bot place l&apos;ordre à ma place</span>
                {(!address || !isPolygon) && (
                  <span className="text-xs text-muted-foreground">(connecte ton wallet sur Polygon)</span>
                )}
              </label>
              {address && isPolygon && (
                <>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs">Type d&apos;ordre</Label>
                    <select
                      value={useMarketOrder ? 'market' : 'limit'}
                      onChange={(e) => setUseMarketOrder(e.target.value === 'market')}
                      className={`${inputClass} w-40`}
                    >
                      <option value="market">Au marché (immédiat)</option>
                      <option value="limit">Limite (96,8–97 %)</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label htmlFor="order-size-usd" className="text-xs">Montant (USDC)</Label>
                    <input
                      id="order-size-usd"
                      type="number"
                      min="1"
                      step="1"
                      value={orderSizeUsd}
                      onChange={(e) => setOrderSizeUsd(e.target.value)}
                      className={`${inputClass} w-24`}
                    />
                  </div>
                </>
              )}
            </div>
            {placeResult && (
              <p className={`text-sm ${placeResult.error ? 'text-red-500 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                {placeResult.error ?? `Ordre placé. ID: ${placeResult.orderID}`}
              </p>
            )}
            {signalsError && (
              <p className="text-sm text-red-500 dark:text-red-400">{signalsError}</p>
            )}
            {signalsLoading ? (
              <p className="text-sm text-muted-foreground">Chargement des marchés…</p>
            ) : signals.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun marché Bitcoin Up or Down - Hourly avec un prix entre 96,8 % et 97 % pour l’instant.</p>
            ) : (
              <ul className="space-y-2.5">
                {signals.map((s, i) => {
                const key = s.market?.conditionId ?? s.eventSlug ?? i;
                const canPlace = address && isPolygon && s.tokenIdToBuy && placingFor !== key && !isInLastMinute(s);
                return (
                  <li key={key} className="flex flex-wrap items-center gap-3 rounded-lg border border-border/40 bg-card/50 px-4 py-3 hover:bg-card/70 transition-colors">
                    <span className="text-muted-foreground line-clamp-1 flex-1 min-w-0">{s.question}</span>
                    <span className="shrink-0 font-medium text-foreground inline-flex items-center gap-2">
                      <UpDownDot side={s.takeSide} />
                      <span className="text-xs text-muted-foreground">Prendre</span>
                    </span>
                    <span className="shrink-0 text-muted-foreground inline-flex items-center gap-2 text-xs">
                      <span className="inline-flex items-center gap-1"><UpDownDot side="Up" title={false} /> {(s.priceUp * 100).toFixed(1)} %</span>
                      <span className="text-border">/</span>
                      <span className="inline-flex items-center gap-1"><UpDownDot side="Down" title={false} /> {(s.priceDown * 100).toFixed(1)} %</span>
                    </span>
                    {canPlace && (
                      <button
                        type="button"
                        onClick={() => handlePlaceOrder(s)}
                        className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 active:scale-[0.98] transition-all"
                      >
                        Placer ordre
                      </button>
                    )}
                    {placingFor === key && <span className="text-xs text-muted-foreground animate-pulse">Envoi…</span>}
                    {!s.tokenIdToBuy && <span className="text-xs text-amber-600">(token non dispo)</span>}
                    {address && isPolygon && s.tokenIdToBuy && placingFor !== key && isInLastMinute(s) && (
                      <span className="text-xs text-muted-foreground">Fin dans &lt; 1 min</span>
                    )}
                    <a
                      href={s.marketUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-xs font-medium text-primary hover:underline"
                    >
                      Ouvrir →
                    </a>
                  </li>
                );
              })}
              </ul>
            )}
            <button
              type="button"
              onClick={refreshSignals}
              disabled={signalsLoading}
              className="rounded-xl border border-border px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50"
            >
              Rafraîchir
            </button>
          </div>

          <div className="rounded-xl border border-border/50 bg-muted/10 p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <span className="w-1 h-4 rounded-full bg-primary/60" aria-hidden />
              Résultats des heures passées
            </h3>
            <p className="text-xs text-muted-foreground">
              Créneaux Bitcoin Up or Down déjà résolus. Simulation « si le bot avait été actif » via l’historique des prix CLOB (96,8–97 %).
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
                    </tr>
                  </thead>
                  <tbody>
                    {resolvedHours.map((r, i) => (
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {resolvedHours.length > 0 && (() => {
              const withSimul = resolvedHours.filter((r) => r.botWon !== null);
              const won = withSimul.filter((r) => r.botWon === true).length;
              if (withSimul.length > 0) {
                return (
                  <p className="text-xs text-muted-foreground mt-2">
                    Simulation : <strong>{won}</strong> gagnés / <strong>{withSimul.length}</strong> créneaux avec signal 96,8–97 %.
                  </p>
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
            const withEntry = resolvedHours.filter((r) => r.botEntryTimestamp != null && r.endDate);
            if (withEntry.length === 0) return null;
            const sessionDurationSec = 3600;
            const minutesList = withEntry.map((r) => {
              const sessionEndSec = new Date(r.endDate).getTime() / 1000;
              const sessionStartSec = sessionEndSec - sessionDurationSec;
              return (r.botEntryTimestamp - sessionStartSec) / 60;
            });
            const avgMinutes = minutesList.reduce((a, b) => a + b, 0) / minutesList.length;
            return (
              <div className="rounded-xl border border-border/50 bg-muted/10 p-5 space-y-2">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <span className="w-1 h-4 rounded-full bg-primary/60" aria-hidden />
                  Moyenne d&apos;entrée des trades
                </h3>
                <p className="text-sm text-muted-foreground">
                  Sur les <strong className="text-foreground">{withEntry.length}</strong> sessions affichées avec heure d&apos;entrée : le bot entre en moyenne à <strong className="text-primary">{avgMinutes.toFixed(1)} min</strong> après le début du créneau horaire.
                </p>
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
