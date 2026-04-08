/**
 * Résumés Telegram performance : entrées, SL, redeems, WR, séries (fenêtres minuit→midi, midi→minuit, journée complète).
 * Fuseau : TELEGRAM_MIDDAY_DIGEST_TZ (défaut Europe/Paris).
 */
import fs from 'fs';

/** @param {number} utcMs @param {string} timeZone @returns {string} YYYY-MM-DD HH:mm:ss */
function formatInTimeZone(utcMs, timeZone) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(utcMs));
}

/**
 * [startMs, endMs) pour le jour calendaire `dateStr` (YYYY-MM-DD) dans `timeZone`, de 00:00 à 12:00 local (fin exclusive).
 */
export function getMidnightToNoonWindowMs(timeZone, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const targetDate = `${y}-${pad(m)}-${pad(d)}`;
  const lo = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
  const hi = Date.UTC(y, m - 1, d + 2, 0, 0, 0);
  let startMs = null;
  let endMs = null;
  for (let t = lo; t <= hi; t += 1000) {
    const s = formatInTimeZone(t, timeZone);
    if (startMs == null && s.startsWith(`${targetDate} 00:00:00`)) startMs = t;
    if (s.startsWith(`${targetDate} 12:00:00`)) {
      endMs = t;
      break;
    }
  }
  if (startMs == null || endMs == null) return null;
  return { startMs, endMs };
}

/**
 * [startMs, endMs) pour le jour calendaire `dateStr` dans `timeZone`, de 12:00 local au lendemain 00:00 (fin exclusive).
 */
export function getNoonToMidnightWindowMs(timeZone, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const targetDate = `${y}-${pad(m)}-${pad(d)}`;
  const lo = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
  const hi = Date.UTC(y, m - 1, d + 2, 0, 0, 0);
  let startMs = null;
  for (let t = lo; t <= hi; t += 1000) {
    const s = formatInTimeZone(t, timeZone);
    if (s.startsWith(`${targetDate} 12:00:00`)) {
      startMs = t;
      break;
    }
  }
  if (startMs == null) return null;
  let endMs = null;
  for (let t = startMs + 1000; t <= startMs + 36 * 3600 * 1000; t += 1000) {
    const s = formatInTimeZone(t, timeZone);
    if (s.endsWith(' 00:00:00') && !s.startsWith(targetDate)) {
      endMs = t;
      break;
    }
  }
  if (endMs == null) return null;
  return { startMs, endMs };
}

/**
 * [startMs, endMs) pour le jour calendaire `dateStr` dans `timeZone`, de 00:00 au lendemain 00:00 local (journée complète).
 */
export function getFullDayWindowMs(timeZone, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const targetDate = `${y}-${pad(m)}-${pad(d)}`;
  const lo = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
  const hi = Date.UTC(y, m - 1, d + 2, 0, 0, 0);
  let startMs = null;
  for (let t = lo; t <= hi; t += 1000) {
    const s = formatInTimeZone(t, timeZone);
    if (s.startsWith(`${targetDate} 00:00:00`)) {
      startMs = t;
      break;
    }
  }
  if (startMs == null) return null;
  let endMs = null;
  for (let t = startMs + 1000; t <= startMs + 36 * 3600 * 1000; t += 1000) {
    const s = formatInTimeZone(t, timeZone);
    if (s.endsWith(' 00:00:00') && !s.startsWith(targetDate)) {
      endMs = t;
      break;
    }
  }
  if (endMs == null) return null;
  return { startMs, endMs };
}

/** Jour calendaire « hier » dans le fuseau (pour digests à minuit). */
export function getYesterdayYmdInTz(timeZone) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() - 12 * 3600 * 1000));
}

/** Entrée d'achat (pas ligne SL). */
export function isEntryOrderLine(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.stopLossTriggerPriceP != null) return false;
  if (obj.stopLossExit === true || obj.stopLossExitAttemptFailed === true) return false;
  const fu = Number(obj.filledUsdc);
  if (!Number.isFinite(fu) || fu <= 0) return false;
  if (obj.event === 'resolution_redeem') return false;
  return true;
}

function parseAtMs(at) {
  const t = at ? new Date(at).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/**
 * @param {string} rawLog - contenu orders.log
 * @param {number} startMs
 * @param {number} endMs
 */
export function computeMiddayDigestStats(rawLog, startMs, endMs) {
  const lines = rawLog.split('\n');
  /** @type {{ t: number, type: 'entry'|'sl'|'win', conditionId: string }[]} */
  const events = [];

  let entriesCount = 0;
  let slCount = 0;
  let winCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const t = parseAtMs(obj.at);
    if (!Number.isFinite(t) || t < startMs || t >= endMs) continue;

    const cid = String(obj.conditionId || '').trim();
    if (obj.stopLossExit === true && cid) {
      slCount += 1;
      events.push({ t, type: 'sl', conditionId: cid });
      continue;
    }
    if (obj.event === 'resolution_redeem' && obj.outcome === 'win' && cid) {
      winCount += 1;
      events.push({ t, type: 'win', conditionId: cid });
      continue;
    }
    if (isEntryOrderLine(obj)) {
      entriesCount += 1;
      events.push({ t, type: 'entry', conditionId: cid });
    }
  }

  events.sort((a, b) => a.t - b.t);

  /** Résultats binaires dans l'ordre (SL = défaite, redeem win = victoire) — ignore les entrées seules pour la série. */
  const outcomes = events.filter((e) => e.type === 'sl' || e.type === 'win').map((e) => (e.type === 'win' ? 'W' : 'L'));

  const { maxWinStreak, maxLossStreak, currentWinStreak, currentLossStreak } = streaksFromOutcomes(outcomes);

  const decided = winCount + slCount;
  const wrPct = decided > 0 ? Math.round((winCount / decided) * 1000) / 10 : null;

  return {
    entriesCount,
    slCount,
    winCount,
    decided,
    wrPct,
    outcomesStr: outcomes.join(''),
    maxWinStreak,
    maxLossStreak,
    currentWinStreak,
    currentLossStreak,
  };
}

export function streaksFromOutcomes(outcomes) {
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let curW = 0;
  let curL = 0;
  for (const o of outcomes) {
    if (o === 'W') {
      curW += 1;
      curL = 0;
      maxWinStreak = Math.max(maxWinStreak, curW);
    } else {
      curL += 1;
      curW = 0;
      maxLossStreak = Math.max(maxLossStreak, curL);
    }
  }
  let currentWinStreak = 0;
  let currentLossStreak = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i] === 'W') currentWinStreak += 1;
    else break;
  }
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i] === 'L') currentLossStreak += 1;
    else break;
  }
  return { maxWinStreak, maxLossStreak, currentWinStreak, currentLossStreak };
}

/**
 * @param {object} opts
 * @param {'midi'|'minuit'|'fin'} [opts.streakContextLabel] — libellé pour la ligne « série » (défaut : midi).
 */
export function formatMiddayDigestMessage(stats, { timeZone, dateStr, windowLabel, streakContextLabel = 'midi' }) {
  const wrLine =
    stats.decided > 0
      ? `📈 WR (${windowLabel}) : ${stats.wrPct}% (${stats.winCount} 🎯 / ${stats.decided} décisions — 🏆 ${stats.winCount} redeem gagnant${stats.winCount > 1 ? 's' : ''}, 🛑 ${stats.slCount} SL)`
      : `📈 WR (${windowLabel}) : — (aucune sortie SL ni redeem « victoire » sur la période)`;

  const streakNow =
    stats.currentWinStreak > 0
      ? `🔥 ${stats.currentWinStreak} victoire${stats.currentWinStreak > 1 ? 's' : ''} d’affilée`
      : stats.currentLossStreak > 0
        ? `📉 ${stats.currentLossStreak} défaite${stats.currentLossStreak > 1 ? 's' : ''} d’affilée`
        : '➖ —';

  const streakPhrase =
    streakContextLabel === 'minuit'
      ? 'à minuit (fin de fenêtre)'
      : streakContextLabel === 'fin'
        ? 'fin de journée'
        : 'à midi';

  return (
    `🎯 Résumé Sniper · ${windowLabel}\n` +
    `📅 ${dateStr} · 🌍 ${timeZone}\n` +
    `➖➖➖\n` +
    `🛒 Ordres d’entrée : ${stats.entriesCount}\n` +
    `🛑 Stop-loss (défaites) : ${stats.slCount}\n` +
    `🏆 Redeem victoire : ${stats.winCount}\n` +
    `${wrLine}\n` +
    `➖➖➖\n` +
    `📌 Séries (🛑 SL + 🏆 Win, ordre chrono)\n` +
    `🔥 Max victoires d’affilée : ${stats.maxWinStreak}\n` +
    `📉 Max défaites d’affilée : ${stats.maxLossStreak}\n` +
    `⚡ Série ${streakPhrase} : ${streakNow}\n` +
    (stats.outcomesStr ? `🧩 Séquence : ${stats.outcomesStr}\n` : '')
  ).trim();
}

/**
 * @param {string} ordersLogPath
 * @param {string} statePath - dernier jour envoyé
 */
export function readOrdersLogSafe(ordersLogPath) {
  try {
    return fs.readFileSync(ordersLogPath, 'utf8');
  } catch {
    return '';
  }
}

/** Jour calendaire YYYY-MM-DD dans le fuseau. */
export function getCalendarDateYmd(timeZone) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Heure locale (0–23, 0–59) dans le fuseau. */
export function getLocalHourMinute(timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hour = +parts.find((p) => p.type === 'hour').value;
  const minute = +parts.find((p) => p.type === 'minute').value;
  return { hour, minute };
}
