/**
 * Retourne la date de clôture d'un marché en millisecondes (timestamp).
 * L'API peut renvoyer endDate, end_date_iso ou end_date (secondes).
 */
export function getMarketEndTime(market) {
  if (!market) return null;
  const raw =
    market.endDate ??
    market.end_date_iso ??
    market.endDateIso ??
    market.end_date ??
    market.closedTime ??
    market.finishedTimestamp;
  if (raw == null || raw === '') return null;
  const date =
    typeof raw === 'number'
      ? new Date(raw > 1e12 ? raw : raw * 1000)
      : new Date(raw);
  const ts = date.getTime();
  return Number.isNaN(ts) ? null : ts;
}

/**
 * Retourne la chaîne ou valeur de date de clôture pour affichage (compat MarketCard).
 */
export function getMarketEndDate(market) {
  if (!market) return '';
  const raw =
    market.endDate ??
    market.end_date_iso ??
    market.endDateIso ??
    market.closedTime ??
    market.finishedTimestamp;
  if (raw == null || raw === '') return market.end_date != null ? new Date(market.end_date > 1e12 ? market.end_date : market.end_date * 1000).toISOString() : '';
  if (typeof raw === 'number') return new Date(raw > 1e12 ? raw : raw * 1000).toISOString();
  return String(raw);
}

/**
 * Formate un volume en dollars (ex: 125430.50 → "$125k", 1200000 → "$1.2M")
 */
export function formatVolume(value) {
  const num = parseFloat(value) || 0;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(0)}k`;
  return `$${num.toFixed(0)}`;
}

/**
 * Formate un pourcentage (ex: 0.73 → "73%")
 */
export function formatPercent(value) {
  const num = parseFloat(value);
  if (Number.isNaN(num)) return '—';
  return `${Math.round(num * 100)}%`;
}

/**
 * Retourne un libellé en français pour le délai jusqu'à la date de clôture
 * "Dans 2 jours", "Dans 5h", "Expiré", etc.
 */
export function formatTimeUntil(endDateStr) {
  if (endDateStr == null || endDateStr === '') return '—';
  const end = new Date(endDateStr);
  const now = new Date();
  const diffMs = end - now;
  if (Number.isNaN(diffMs)) return '—';

  if (diffMs <= 0) return 'Expiré';

  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 60) return `Dans ${diffMinutes} min`;
  if (diffHours < 24) return `Dans ${diffHours}h`;
  if (diffDays === 1) return 'Dans 1 jour';
  return `Dans ${diffDays} jours`;
}

/**
 * Catégorie d'opportunité selon le délai avant clôture
 * @returns { 'urgent' | 'soon' | 'normal' }
 */
export function getOpportunityCategory(endDateStr) {
  if (endDateStr == null || endDateStr === '') return 'normal';
  const end = new Date(endDateStr);
  const now = new Date();
  const diffMs = end - now;
  if (Number.isNaN(diffMs) || diffMs <= 0) return 'normal';
  const diffHours = diffMs / (1000 * 60 * 60);
  if (diffHours < 24) return 'urgent';
  if (diffHours < 72) return 'soon'; // 1–3 jours
  return 'normal';
}
