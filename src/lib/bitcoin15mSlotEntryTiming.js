import { POLYMARKET_DISPLAY_TZ } from './polymarketDisplayTime.js';

const QUARTER_SEC = 15 * 60;

/** Pas d’entrée pendant les 3 premières minutes de chaque quart d’heure **affiché ET** (:00–:02). */
export const SLOT_15M_ENTRY_FORBID_FIRST_SEC = 3 * 60;
/** Pas d’entrée pendant les 4 dernières minutes du quart **en ET** (:11–:14 du bloc). */
export const SLOT_15M_ENTRY_FORBID_LAST_SEC = 4 * 60;

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
 * @param {number} [_slotEndSec] — ignoré (conservé pour compatibilité des appelants)
 */
export function is15mSlotEntryTimeForbidden(tsSec, _slotEndSec = null) {
  const o = offsetSecondsInEtQuarterHour(tsSec);
  if (o == null) return false;
  if (o < SLOT_15M_ENTRY_FORBID_FIRST_SEC) return true;
  if (o >= QUARTER_SEC - SLOT_15M_ENTRY_FORBID_LAST_SEC) return true;
  return false;
}

/**
 * Signaux live : même grille ET (plus besoin de `slotEndMs` pour cette règle).
 * @param {number} nowMs
 * @param {number} [_slotEndMs]
 */
export function isLive15mEntryForbiddenNow(nowMs, _slotEndMs = null) {
  if (!Number.isFinite(nowMs)) return false;
  return is15mSlotEntryTimeForbidden(Math.floor(nowMs / 1000), null);
}

export { POLYMARKET_DISPLAY_TZ as ENTRY_TIMING_ET_TIMEZONE };
