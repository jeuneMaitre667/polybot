import { useMemo } from 'react';
import {
  DEPTH_DISPLAY_MAX_P,
  DEPTH_DISPLAY_MIN_P,
  depthRowTier,
  filterLevelsInPriceRange,
  normalizeAskLevels,
} from '@/lib/orderBookDepth.js';

function formatPrice(p) {
  return Number(p).toFixed(3);
}

function formatVol(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('fr-FR');
}

function useSplitDepthRows(asksUp, asksDown) {
  return useMemo(() => {
    const upLevels = filterLevelsInPriceRange(
      normalizeAskLevels(asksUp),
      DEPTH_DISPLAY_MIN_P,
      DEPTH_DISPLAY_MAX_P
    );
    const downLevels = filterLevelsInPriceRange(
      normalizeAskLevels(asksDown),
      DEPTH_DISPLAY_MIN_P,
      DEPTH_DISPLAY_MAX_P
    );
    const maxU = Math.max(1e-6, ...upLevels.map((r) => r.usd), ...downLevels.map((r) => r.usd));
    const mapRows = (levels) =>
      levels.map((r) => ({
        ...r,
        tier: depthRowTier(r.price),
        widthPct: Math.min(100, (r.usd / maxU) * 100),
      }));
    return { rowsUp: mapRows(upLevels), rowsDown: mapRows(downLevels) };
  }, [asksUp, asksDown]);
}

/**
 * Une colonne Up ou Down — style proche du carnet Polymarket (prix, profondeur, volume).
 * @param {{ side: 'up' | 'down', label: string, rows: object[], mirror?: boolean, wonLastSlot?: boolean }} props
 */
function OrderBookColumn({ side, label, rows, mirror, wonLastSlot }) {
  const headCls = mirror ? 'pm-ob__head pm-ob__head--mirror' : 'pm-ob__head';
  const rowCls = (tier) =>
    `pm-ob__row pm-ob__row--${side} pm-ob__row--${tier}${mirror ? ' pm-ob__row--mirror' : ''}`;

  const priceCell = (r) => (
    <span className="pm-ob__price" role="cell">
      {formatPrice(r.price)}
      {r.tier === 'signal' && (
        <span className={`pm-ob__tick pm-ob__tick--${side}`} aria-hidden>
          ✓
        </span>
      )}
    </span>
  );

  const barCell = (r) => (
    <div className="pm-ob__bar-cell" role="cell">
      <div className={mirror ? 'pm-ob__bar-track pm-ob__bar-track--mirror' : 'pm-ob__bar-track'}>
        <div className="pm-ob__bar-fill" style={{ width: `${r.widthPct}%` }} title={`${r.usd.toFixed(2)} $`} />
      </div>
    </div>
  );

  const volCell = (r) => (
    <span className="pm-ob__vol" role="cell">
      {formatVol(r.size)}
    </span>
  );

  return (
    <div
      className={`pm-ob__col pm-ob__col--${side}${wonLastSlot ? ' pm-ob__col--last-winner' : ''}`}
      role="group"
      aria-label={`Asks ${label}${wonLastSlot ? ' — a gagné le dernier créneau' : ''}`}
    >
      <div className={`pm-ob__col-title pm-ob__col-title--${side}`}>
        <span className={`pm-ob__outcome-dot pm-ob__outcome-dot--${side}`} aria-hidden />
        <span>{label}</span>
        {wonLastSlot && (
          <span className="pm-ob__win-pill" title="Résultat du dernier créneau 15m terminé (Gamma)">
            Gagnant
          </span>
        )}
      </div>
      <div className={headCls} role="row">
        {mirror ? (
          <>
            <span role="columnheader">Volume</span>
            <span role="columnheader">Liquidité</span>
            <span role="columnheader">Prix</span>
          </>
        ) : (
          <>
            <span role="columnheader">Prix</span>
            <span role="columnheader">Liquidité</span>
            <span role="columnheader">Volume</span>
          </>
        )}
      </div>
      <div className="pm-ob__body">
        {rows.length === 0 ? (
          <p className="pm-ob__empty">Aucun ask dans la fenêtre {DEPTH_DISPLAY_MIN_P} – {DEPTH_DISPLAY_MAX_P}</p>
        ) : (
          rows.map((r, i) =>
            mirror ? (
              <div key={`${side}-${r.price}-${i}`} className={rowCls(r.tier)} role="row">
                {volCell(r)}
                {barCell(r)}
                {priceCell(r)}
              </div>
            ) : (
              <div key={`${side}-${r.price}-${i}`} className={rowCls(r.tier)} role="row">
                {priceCell(r)}
                {barCell(r)}
                {volCell(r)}
              </div>
            )
          )
        )}
      </div>
    </div>
  );
}

/**
 * Carnet d’ordres asks — créneau 15m actuel, deux colonnes Up / Down (comme sur Polymarket).
 * @param {{
 *   asksUp?: unknown[],
 *   asksDown?: unknown[],
 *   lastAt?: string | null,
 *   lastResolved15mSlot?: { winner: 'Up' | 'Down' | null, label: string, slotEndSec?: number } | null,
 * }} props
 */
export function MiseMax15mOrderBookDepth({ asksUp = [], asksDown = [], lastAt, lastResolved15mSlot = null }) {
  const { rowsUp, rowsDown } = useSplitDepthRows(asksUp, asksDown);

  const timeStr = lastAt
    ? new Date(lastAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

  const lastWinner = lastResolved15mSlot?.winner ?? null;
  const winUp = lastWinner === 'Up';
  const winDown = lastWinner === 'Down';

  return (
    <div className="mise-max-depth pm-ob">
      <p className="mise-max-depth-title">Carnet d&apos;ordres — Bitcoin 15m (Up / Down)</p>
      <p className="pm-ob__subtitle">
        Créneau <strong>en cours</strong> : asks dans la fenêtre prix (bot 97–97,5 %). Le bandeau indique le{' '}
        <strong>dernier créneau terminé</strong>.
      </p>

      {lastResolved15mSlot != null && (
        <div className="pm-ob__last-banner" role="status">
          <span className="pm-ob__last-banner-title">Dernier créneau terminé</span>
          <span className="pm-ob__last-banner-meta"> · fin {lastResolved15mSlot.label}</span>
          <span className="pm-ob__last-banner-sep"> — </span>
          {lastWinner ? (
            <>
              résultat :{' '}
              <strong className={winUp ? 'pm-ob__win-text--up' : 'pm-ob__win-text--down'}>{lastWinner}</strong>
              <span className="pm-ob__last-banner-hint"> (colonne surlignée)</span>
            </>
          ) : (
            <span className="pm-ob__last-banner-pending">
              résolution non lue sur Gamma (marché encore ouvert ou prix non finalisés).
            </span>
          )}
        </div>
      )}

      <div className="pm-ob__grid" role="presentation">
        <OrderBookColumn side="up" label="Up" rows={rowsUp} mirror={false} wonLastSlot={winUp} />
        <div className="pm-ob__spine" aria-hidden />
        <OrderBookColumn side="down" label="Down" rows={rowsDown} mirror wonLastSlot={winDown} />
      </div>

      {rowsUp.length === 0 && rowsDown.length === 0 && (
        <p className="mise-max-depth-empty pm-ob__both-empty-note">
          Aucune ligne d&apos;ask dans la fenêtre affichée pour ce créneau (carnets vides ou hors plage 97–97,5 %).
        </p>
      )}

      <div className="mise-max-depth-footer">
        <div className="mise-max-depth-footer-left">
          <span>
            Fenêtre : {DEPTH_DISPLAY_MIN_P} → {DEPTH_DISPLAY_MAX_P}
          </span>
        </div>
        <span className="mise-max-depth-footer-right">
          Dernière MAJ : {timeStr}
          <span className="pm-ob__footer-poll" title="Carnet créneau actuel + résultat dernier créneau">
            {' '}
            · auto ~1 s
          </span>
        </span>
      </div>
    </div>
  );
}
