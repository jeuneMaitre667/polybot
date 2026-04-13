/**
 * Lecture des marchés Gamma pour Bitcoin Up/Down.
 *
 * Schéma OpenAPI `Market` : `outcomes`, `outcomePrices`, `clobTokenIds` sont des chaînes (souvent JSON)
 * — même ordre d’index pour prix et libellés.
 *
 * @see https://docs.polymarket.com/api-spec/gamma-openapi.yaml
 * @see https://docs.polymarket.com/market-data/fetching-markets
 * @see https://docs.polymarket.com/concepts/resolution
 */
import { GAMMA_RESOLVED_PRICE_THRESHOLD } from '@/lib/polymarketGammaDocs.js';

const RESOLVED_UP_DOWN_WIN_THRESHOLD = GAMMA_RESOLVED_PRICE_THRESHOLD;

/**
 * Parse `outcomePrices` / `outcome_prices` en nombres (ordre **identique** à `outcomes[]` côté Gamma,
 * souvent **["Down","Up"]** alphabétique — pas toujours [Up, Down]).
 */
export function parseGammaOutcomePrices(market) {
  if (!market || typeof market !== 'object') return null;
  try {
    const raw = market.outcomePrices ?? market.outcome_prices;
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length < 2) return null;
    return arr.map((x) => {
      const n = parseFloat(x);
      return Number.isFinite(n) ? n : 0;
    });
  } catch {
    return null;
  }
}

/**
 * Libellés d’outcomes Gamma (`["Down","Up"]` ou `["Up","Down"]`, chaîne JSON ou tableau).
 */
function normalizeOutcomeLabel(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function parseOutcomesArrayField(raw) {
  if (raw == null) return null;
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length < 2) return null;
    return arr.map((x) => String(x).trim());
  } catch {
    return null;
  }
}

/**
 * Libellés d’outcomes : champ `outcomes`, sinon `shortOutcomes` (tous deux `string` JSON dans l’OpenAPI Market).
 */
export function parseGammaOutcomesLabels(market) {
  if (!market || typeof market !== 'object') return null;
  return parseOutcomesArrayField(market.outcomes) ?? parseOutcomesArrayField(market.shortOutcomes);
}

/**
 * Gamma met souvent `outcomes` / `tokens` sur l’**event**, pas sur chaque `markets[]`.
 * Sans fusion, on retombait sur l’hypothèse [0]=Up [1]=Down → résultats inversés vs Polymarket.
 */
export function mergeGammaEventMarketForUpDown(ev, market) {
  if (!market || typeof market !== 'object') return market;
  const out = { ...market };
  if (out.outcomes == null && ev != null && typeof ev === 'object' && ev.outcomes != null) {
    out.outcomes = ev.outcomes;
  }
  const mTok = Array.isArray(out.tokens) ? out.tokens : [];
  const evTok = ev != null && typeof ev === 'object' && Array.isArray(ev.tokens) ? ev.tokens : [];
  if (mTok.length < 2 && evTok.length >= 2) out.tokens = ev.tokens;
  return out;
}

/**
 * Indices des colonnes Up / Down dans `outcomePrices` et `clobTokenIds` (alignés sur `outcomes` quand présent).
 * Repli historique : 0 = Up, 1 = Down.
 */
export function getUpDownOutcomeIndices(market) {
  const labels = parseGammaOutcomesLabels(market);
  if (labels) {
    const iUp = labels.findIndex((l) => normalizeOutcomeLabel(l) === 'up');
    const iDown = labels.findIndex((l) => normalizeOutcomeLabel(l) === 'down');
    if (iUp >= 0 && iDown >= 0 && iUp < labels.length && iDown < labels.length) {
      return { idxUp: iUp, idxDown: iDown };
    }
  }
  const tokens = market?.tokens;
  if (Array.isArray(tokens) && tokens.length >= 2) {
    const names = tokens.map((t) =>
      String(t?.outcome ?? t?.name ?? t?.title ?? t?.label ?? '').trim()
    );
    const iUp = names.findIndex((l) => normalizeOutcomeLabel(l) === 'up');
    const iDown = names.findIndex((l) => normalizeOutcomeLabel(l) === 'down');
    if (iUp >= 0 && iDown >= 0) return { idxUp: iUp, idxDown: iDown };
  }
  return { idxUp: 0, idxDown: 1 };
}

/**
 * Gagnant marché Bitcoin Up/Down résolu (prix outcome ≥ seuil). Utilise l’ordre réel des outcomes Gamma.
 * @returns {'Up' | 'Down' | null}
 */
export function getResolvedUpDownWinnerFromGammaMarket(market) {
  const prices = parseGammaOutcomePrices(market);
  if (!prices || prices.length < 2) return null;
  const { idxUp, idxDown } = getUpDownOutcomeIndices(market);
  const pUp = prices[idxUp];
  const pDown = prices[idxDown];
  if (!Number.isFinite(pUp) || !Number.isFinite(pDown)) return null;
  if (pUp >= RESOLVED_UP_DOWN_WIN_THRESHOLD && pDown < 0.5) return 'Up';
  if (pDown >= RESOLVED_UP_DOWN_WIN_THRESHOLD && pUp < 0.5) return 'Down';
  return null;
}

/**
 * Gamma renvoie souvent clobTokenIds comme chaîne JSON : '["id1","id2"]' au lieu d'un tableau.
 */
export function coalesceClobTokenIds(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const out = raw.map((x) => String(x).trim()).filter(Boolean);
    return out.length ? out : null;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    // Avant JSON.parse : une chaîne uniquement numérique est un id CLOB (évite que JSON.parse
    // la lise comme nombre et perde la précision sur les grands entiers).
    if (/^\d+$/.test(s)) return [s];
    try {
      const p = JSON.parse(s);
      if (Array.isArray(p)) {
        const out = p.map((x) => String(x).trim()).filter(Boolean);
        return out.length ? out : null;
      }
    } catch {
      /* chaîne non-JSON : déjà couvert par le test /^\d+$/ ci-dessus */
    }
  }
  return null;
}

/**
 * Token CLOB Up / Down : d’abord par libellé sur `tokens[].outcome` (fiable), sinon indices dérivés de `outcomes` + `clobTokenIds`.
 */
/**
 * Indique si `outcomes` et `outcomePrices` sont présents et de même longueur (condition pour appliquer le schéma).
 */
export function gammaMarketOutcomesPricesAligned(market) {
  const labels = parseGammaOutcomesLabels(market);
  const prices = parseGammaOutcomePrices(market);
  if (!labels?.length || !prices?.length) return false;
  return labels.length === prices.length;
}

/**
 * GET /markets/slug/{slug} — documenté comme moyen de récupérer un marché complet par slug d’URL Polymarket.
 */
export async function fetchGammaMarketBySlug(axios, marketBySlugBaseUrl, slug) {
  if (!slug || !axios || !marketBySlugBaseUrl) return null;
  try {
    const { data } = await axios.get(`${marketBySlugBaseUrl}/${encodeURIComponent(String(slug).trim())}`, {
      timeout: 8000,
    });
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Fusionne event+marché embarqué, puis si les champs schema-alignés manquent, recharge via GET /markets/slug/{slug}.
 */
export async function resolveGammaMarketForBtcUpDown(axios, marketBySlugBaseUrl, ev, market) {
  const m = market && typeof market === 'object' ? market : {};
  let merged = mergeGammaEventMarketForUpDown(ev, m);
  const slug = String(m.slug ?? ev?.slug ?? '').trim();
  if (!gammaMarketOutcomesPricesAligned(merged) && slug) {
    const full = await fetchGammaMarketBySlug(axios, marketBySlugBaseUrl, slug);
    if (full) merged = mergeGammaEventMarketForUpDown(ev, { ...m, ...full });
  }
  return merged;
}

export function parseUpDownTokenIdsFromMarket(m) {
  if (!m || typeof m !== 'object') return { tokenIdUp: null, tokenIdDown: null };
  const tokens = Array.isArray(m.tokens) ? m.tokens : [];
  let tokenIdUp = null;
  let tokenIdDown = null;
  for (const t of tokens) {
    const label = normalizeOutcomeLabel(t?.outcome ?? t?.name ?? t?.title ?? t?.label ?? '');
    const tid = t?.token_id ?? t?.tokenId;
    if (tid == null || !String(tid).trim()) continue;
    if (label === 'up') tokenIdUp = String(tid).trim();
    if (label === 'down') tokenIdDown = String(tid).trim();
  }
  if (tokenIdUp && tokenIdDown) return { tokenIdUp, tokenIdDown };

  const idArr = coalesceClobTokenIds(m.clobTokenIds ?? m.clob_token_ids);
  const { idxUp, idxDown } = getUpDownOutcomeIndices(m);
  const pick = (idx) => {
    const fromArr = idArr?.[idx] != null ? String(idArr[idx]).trim() : null;
    if (fromArr) return fromArr;
    const t = tokens[idx];
    const tid = t?.token_id ?? t?.tokenId;
    return tid != null ? String(tid).trim() : null;
  };
  return { tokenIdUp: pick(idxUp), tokenIdDown: pick(idxDown) };
}
