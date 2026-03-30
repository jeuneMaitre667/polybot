import { POLYMARKET_DISPLAY_TZ } from './polymarketDisplayTime.js';

export const QUARTER_SEC_15M = 15 * 60;
const QUARTER_SEC = QUARTER_SEC_15M;

/** Défaut dashboard / backtest : pas de fenêtre interdite en début de quart (0 = désactivé). */
export const SLOT_15M_ENTRY_FORBID_FIRST_SEC = 0;
/** Défaut : pas de fenêtre interdite en fin de quart (0 = désactivé). */
export const SLOT_15M_ENTRY_FORBID_LAST_SEC = 0;

const etHmsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: POLYMARKET_DISPLAY_TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Secondes depuis le début du quart d’heure **America/New_York** (début à :00, :15, :30, :45 heure locale).
 * @param {number} tsSec Unix s
 * @returns {number|null} 0..899 ou null si illisible
 */
export function offsetSecondsInEtQuarterHour(tsSec) {
  if (tsSec == null || !Number.isFinite(Number(tsSec))) return null;
  const ms = Math.floor(Number(tsSec)) * 1000;
  const parts = etHmsFormatter.formatToParts(new Date(ms));
  let h = NaN;
  let m = NaN;
  let s = NaN;
  for (const p of parts) {
    if (p.type === 'hour') h = Number(p.value);
    if (p.type === 'minute') m = Number(p.value);
    if (p.type === 'second') s = Number(p.value);
  }
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
  const minsFromMidnight = h * 60 + m;
  const offsetMin = minsFromMidnight % 15;
  return offsetMin * 60 + s;
}

/**
 * Règle **simple** alignée sur l’UI Polymarket (heure ET) : pas d’entrée en début / fin de quart,
 * quel que soit le décalage slug Unix vs affichage (trades API après fin UTC, etc.).
 *
 * @param {number} tsSec
 */
/**
 * Fenêtres interdites en début / fin de quart (secondes). Si first+last ≥ 15 min, tout le quart est interdit.
 * Minutes clampées 0–14 chacune (un quart = 15 min).
 */
export function normalizeForbidWindowMinutes(firstMin, lastMin) {
  let f = firstMin === undefined || firstMin === null ? NaN : Math.round(Number(firstMin));
  let l = lastMin === undefined || lastMin === null ? NaN : Math.round(Number(lastMin));
  if (!Number.isFinite(f)) f = SLOT_15M_ENTRY_FORBID_FIRST_SEC / 60;
  if (!Number.isFinite(l)) l = SLOT_15M_ENTRY_FORBID_LAST_SEC / 60;
  f = Math.max(0, Math.min(14, f));
  l = Math.max(0, Math.min(14, l));
  return { forbidFirstSec: f * 60, forbidLastSec: l * 60 };
}

/** Backtest / overrides : mêmes règles géométriques que la grille bot, paramètres en secondes. */
export function is15mSlotEntryTimeForbiddenWithWindows(tsSec, forbidFirstSec, forbidLastSec) {
  const o = offsetSecondsInEtQuarterHour(tsSec);
  if (o == null) return false;
  const f = Math.max(0, Number(forbidFirstSec) || 0);
  const l = Math.max(0, Number(forbidLastSec) || 0);
  if (f + l >= QUARTER_SEC) return true;
  if (o < f) return true;
  if (o >= QUARTER_SEC - l) return true;
  return false;
}

/**
 * Même règle « N premières / M dernières minutes » mais par rapport au **créneau marché** UTC
 * `[slotEndSec - 900, slotEndSec]` (slug `btc-updown-15m-*`), pas au quart d’heure horloge ET.
 *
 * À utiliser pour le **backtest** quand `slotEndSec` est connu : les points `prices-history` sont filtrés
 * sur cette fenêtre ; utiliser le quart ET global pouvait décaler l’interdiction vs les données et fausser
 * le nombre de signaux / le WR quand on bouge les minutes interdites.
 *
 * Hors `[slotStart, slotEnd]` (marges fetch) : repli sur `is15mSlotEntryTimeForbiddenWithWindows` (grille ET),
 * aligné bot live.
 *
 * @param {number} tsSec
 * @param {number|null|undefined} slotEndSec fin du créneau 15m (s UTC), ex. depuis le slug
 * @param {number} forbidFirstSec
 * @param {number} forbidLastSec
 */
export function is15mMarketSlotEntryTimeForbidden(tsSec, slotEndSec, forbidFirstSec, forbidLastSec) {
  const f = Math.max(0, Number(forbidFirstSec) || 0);
  const l = Math.max(0, Number(forbidLastSec) || 0);
  if (f + l >= QUARTER_SEC) return true;
  if (slotEndSec == null || !Number.isFinite(Number(slotEndSec))) {
    return is15mSlotEntryTimeForbiddenWithWindows(tsSec, forbidFirstSec, forbidLastSec);
  }
  const end = Math.floor(Number(slotEndSec));
  const slotStartSec = end - QUARTER_SEC;
  const ts = Number(tsSec);
  if (!Number.isFinite(ts)) return false;
  const o = ts - slotStartSec;
  if (o >= 0 && o < QUARTER_SEC) {
    if (o < f) return true;
    if (l > 0 && o >= QUARTER_SEC - l) return true;
    return false;
  }
  return is15mSlotEntryTimeForbiddenWithWindows(tsSec, forbidFirstSec, forbidLastSec);
}

export function is15mSlotEntryTimeForbidden(tsSec) {
  return is15mSlotEntryTimeForbiddenWithWindows(
    tsSec,
    SLOT_15M_ENTRY_FORBID_FIRST_SEC,
    SLOT_15M_ENTRY_FORBID_LAST_SEC,
  );
}

/**
 * Signaux live : même grille ET.
 * @param {number} nowMs
 */
export function isLive15mEntryForbiddenNow(nowMs) {
  if (!Number.isFinite(nowMs)) return false;
  return is15mSlotEntryTimeForbidden(Math.floor(nowMs / 1000));
}

export { POLYMARKET_DISPLAY_TZ as ENTRY_TIMING_ET_TIMEZONE };
