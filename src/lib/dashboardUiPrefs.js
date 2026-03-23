/** Préférences UI dashboard (survit au F5). */

export const DASHBOARD_UI_STORAGE_KEYS = {
  latencyMode: 'pm-dashboard-latency-mode',
  stratResultMode: 'pm-dashboard-strat-result-mode',
};

/**
 * @param {boolean} has15mUrl — `VITE_BOT_STATUS_URL_15M` défini
 * @returns {'1h' | '15m'}
 */
export function readLatencyModeFromStorage(has15mUrl) {
  try {
    const v = localStorage.getItem(DASHBOARD_UI_STORAGE_KEYS.latencyMode);
    if (v === '1h') return '1h';
    if (v === '15m') return has15mUrl ? '15m' : '1h';
  } catch {
    /* private mode / quota */
  }
  return has15mUrl ? '15m' : '1h';
}

/** @param {'1h' | '15m'} mode */
export function writeLatencyModeToStorage(mode) {
  try {
    localStorage.setItem(DASHBOARD_UI_STORAGE_KEYS.latencyMode, mode);
  } catch {
    /* ignore */
  }
}

/** @returns {'hourly' | '15m'} */
export function readStratResultModeFromStorage() {
  try {
    const v = localStorage.getItem(DASHBOARD_UI_STORAGE_KEYS.stratResultMode);
    if (v === 'hourly' || v === '15m') return v;
  } catch {
    /* ignore */
  }
  return '15m';
}

/** @param {'hourly' | '15m'} mode */
export function writeStratResultModeToStorage(mode) {
  try {
    localStorage.setItem(DASHBOARD_UI_STORAGE_KEYS.stratResultMode, mode);
  } catch {
    /* ignore */
  }
}
