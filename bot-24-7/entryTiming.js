/**
 * Grille ET 5m alignée sur le dashboard (slot entry timing).
 * Minutes configurables via ENTRY_FORBIDDEN_FIRST_MIN / ENTRY_FORBIDDEN_LAST_MIN (défaut 0 / 0 = tout le créneau).
 */

const POLYMARKET_DISPLAY_TZ = 'America/New_York';
const QUARTER_SEC = 15 * 60;

function parseForbidWindowFromEnv() {
  const rf = process.env.ENTRY_FORBIDDEN_FIRST_MIN;
  const rl = process.env.ENTRY_FORBIDDEN_LAST_MIN;
  let f = rf === undefined || rf === '' ? NaN : Number(rf);
  let l = rl === undefined || rl === '' ? NaN : Number(rl);
  if (!Number.isFinite(f)) f = 0;
  if (!Number.isFinite(l)) l = 0;
  f = Math.max(0, Math.min(14, Math.round(f)));
  l = Math.max(0, Math.min(14, Math.round(l)));
  return {
    forbidFirstSec: f * 60,
    forbidLastSec: l * 60,
    entryForbidFirstMin: f,
    entryForbidLastMin: l,
  };
}

const { forbidFirstSec: FORBID_FIRST_SEC, forbidLastSec: FORBID_LAST_SEC, entryForbidFirstMin, entryForbidLastMin } =
  parseForbidWindowFromEnv();

/** Minutes effectives (après clamp) — pour logs / health. */
export const ENTRY_FORBID_FIRST_MIN_RESOLVED = entryForbidFirstMin;
export const ENTRY_FORBID_LAST_MIN_RESOLVED = entryForbidLastMin;

const etHmsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: POLYMARKET_DISPLAY_TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function offsetSecondsInEtQuarterHour(tsSec) {
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
 * @returns {{ forbidden: boolean, block: 'first_window' | 'last_window' | 'whole_slot' | null, offsetSec: number | null }}
 */
export function getSlotEntryTimingDetail(tsSec) {
  const o = offsetSecondsInEtQuarterHour(tsSec);
  if (o == null) return { forbidden: false, block: null, offsetSec: null };
  if (FORBID_FIRST_SEC + FORBID_LAST_SEC >= QUARTER_SEC) {
    return { forbidden: true, block: 'whole_slot', offsetSec: o };
  }
  if (o < FORBID_FIRST_SEC) return { forbidden: true, block: 'first_window', offsetSec: o };
  if (o >= QUARTER_SEC - FORBID_LAST_SEC) return { forbidden: true, block: 'last_window', offsetSec: o };
  return { forbidden: false, block: null, offsetSec: o };
}

/**
 * @param {number} tsSec — typiquement Math.floor(Date.now() / 1000) au moment où le bot décide de trader
 */
export function isSlotEntryTimeForbiddenNow(tsSec) {
  return getSlotEntryTimingDetail(tsSec).forbidden;
}



