/**
 * Même règle que le dashboard (`src/lib/bitcoin15mSlotEntryTiming.js`) :
 * pas d’entrée pendant les 6 premières minutes ni les 4 dernières de chaque quart d’heure **America/New_York**.
 * Copie locale pour que le bot déployé (dossier bot-24-7 seul) ne dépende pas de `src/`.
 */

const POLYMARKET_DISPLAY_TZ = 'America/New_York';
const QUARTER_SEC = 15 * 60;

const FORBID_FIRST_SEC = 6 * 60;
const FORBID_LAST_SEC = 4 * 60;

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
 * Retourne le détail de la règle de blocage 15m pour le timestamp donné (ET).
 * @returns {{ forbidden: boolean, block: 'first_6min' | 'last_4min' | null, offsetSec: number | null }}
 */
export function get15mSlotEntryTimingDetail(tsSec) {
  const o = offsetSecondsInEtQuarterHour(tsSec);
  if (o == null) return { forbidden: false, block: null, offsetSec: null };
  if (o < FORBID_FIRST_SEC) return { forbidden: true, block: 'first_6min', offsetSec: o };
  if (o >= QUARTER_SEC - FORBID_LAST_SEC) return { forbidden: true, block: 'last_4min', offsetSec: o };
  return { forbidden: false, block: null, offsetSec: o };
}

/**
 * @param {number} tsSec — typiquement Math.floor(Date.now() / 1000) au moment où le bot décide de trader
 */
export function is15mSlotEntryTimeForbiddenNow(tsSec) {
  return get15mSlotEntryTimingDetail(tsSec).forbidden;
}
