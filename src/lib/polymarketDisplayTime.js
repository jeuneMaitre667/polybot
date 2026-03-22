/**
 * Affichage des heures comme sur polymarket.com (Bitcoin Up/Down) : **Eastern Time (ET)**.
 * Les slugs 15m restent en fin de période UTC ; l’UI Polymarket montre la fenêtre en ET (ex. 12:30–12:45 PM ET).
 */

export const POLYMARKET_DISPLAY_TZ = 'America/New_York';

function timeEt(ms) {
  return new Date(ms).toLocaleTimeString('en-US', {
    timeZone: POLYMARKET_DISPLAY_TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function dateEt(ms) {
  return new Date(ms).toLocaleDateString('en-US', {
    timeZone: POLYMARKET_DISPLAY_TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Créneau 15m : "Mar 21, 2026, 12:30 PM – 12:45 PM ET" (style proche du bandeau Polymarket).
 * @param {number} slotEndSec fin du créneau UTC (secondes), comme dans le slug btc-updown-15m-{sec}
 */
export function formatBitcoin15mSlotRangeEt(slotEndSec) {
  if (slotEndSec == null || !Number.isFinite(Number(slotEndSec))) return '—';
  const endMs = Number(slotEndSec) * 1000;
  const startMs = endMs - 15 * 60 * 1000;
  const dStart = dateEt(startMs);
  const dEnd = dateEt(endMs);
  const tStart = timeEt(startMs);
  const tEnd = timeEt(endMs);
  if (dStart === dEnd) {
    return `${dEnd}, ${tStart} – ${tEnd} ET`;
  }
  return `${dStart}, ${tStart} – ${dEnd}, ${tEnd} ET`;
}

/** Horodatage d’un trade / instant : "Mar 21, 2026, 4:48:03 PM ET" */
export function formatTradeTimestampEt(unixSec) {
  if (unixSec == null || !Number.isFinite(Number(unixSec))) return '—';
  const ms = Number(unixSec) * 1000;
  return (
    new Date(ms).toLocaleString('en-US', {
      timeZone: POLYMARKET_DISPLAY_TZ,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }) + ' ET'
  );
}

/** Infobulle technique : même instant en UTC. */
export function formatTimestampUtcTooltip(unixSec) {
  if (unixSec == null || !Number.isFinite(Number(unixSec))) return '';
  return new Date(Number(unixSec) * 1000).toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}

/** Fin de créneau seule (UTC unix → heure de fin en ET), ex. pour debug. */
export function formatSlotEndEt(slotEndSec) {
  if (slotEndSec == null || !Number.isFinite(Number(slotEndSec))) return '—';
  return timeEt(Number(slotEndSec) * 1000) + ' ET';
}

function capitalizeWord(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Libellé horaire depuis le slug Bitcoin hourly Polymarket
 * (ex. …-march-15-2026-4pm-et → March 15, 2026, 4:00 PM ET).
 */
export function formatHourlyEventLabelFromSlug(slug) {
  if (!slug || typeof slug !== 'string') return slug || '—';
  const withYear = slug.match(/-([a-z]+)-(\d+)-(\d+)-(\d+)(am|pm)-et$/i);
  const noYear = slug.match(/-([a-z]+)-(\d+)-(\d+)(am|pm)-et$/i);
  const m = withYear || noYear;
  if (!m) {
    const parts = slug.replace(/-et$/, '').split('-').filter(Boolean);
    return parts.slice(-5).join(' ') || slug;
  }
  const monthRaw = m[1];
  const day = m[2];
  const year = withYear ? m[3] : new Date().getFullYear();
  const hour12 = withYear ? m[4] : m[3];
  const ampm = withYear ? m[5] : m[4];
  return `${capitalizeWord(monthRaw)} ${day}, ${year}, ${hour12}:00 ${ampm.toUpperCase()} ET`;
}
