/**
 * Alignement sémantique Up / Down sur les marchés Gamma (souvent outcomes ["Down","Up"]).
 * Miroir de `src/lib/gammaPolymarket.js` pour le bot sans dépendre du dossier `src/`.
 */

function normalizeOutcomeLabel(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function parseJsonArrayField(raw) {
  if (raw == null) return null;
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

export function mergeGammaEventMarketForUpDown(ev, market) {
  if (!market || typeof market !== 'object') return market;
  const out = { ...market };
  if (out.outcomes == null && ev != null && typeof ev === 'object' && ev.outcomes != null) {
    out.outcomes = ev.outcomes;
  }
  const mTok = Array.isArray(out.tokens) ? out.tokens : [];
  const evTok = ev != null && typeof ev === 'object' && Array.isArray(ev.tokens) ? ev.tokens : [];
  if (mTok.length < 2 && evTok.length >= 2) out.tokens = evTok;
  return out;
}

export function parseGammaOutcomesLabels(market) {
  if (!market || typeof market !== 'object') return null;
  const arr = parseJsonArrayField(market.outcomes) ?? parseJsonArrayField(market.shortOutcomes);
  if (!arr || arr.length < 2) return null;
  return arr.map((x) => String(x).trim());
}

export function parseGammaOutcomePricesNumbers(market) {
  if (!market || typeof market !== 'object') return null;
  const raw = market.outcomePrices ?? market.outcome_prices;
  const arr = parseJsonArrayField(raw);
  if (!arr || arr.length < 2) return null;
  return arr.map((x) => {
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : NaN;
  });
}

export function getUpDownOutcomeIndices(market) {
  const labels = parseGammaOutcomesLabels(market);
  if (labels) {
    const iUp = labels.findIndex((l) => normalizeOutcomeLabel(l) === 'up');
    const iDown = labels.findIndex((l) => normalizeOutcomeLabel(l) === 'down');
    if (iUp >= 0 && iDown >= 0) return { idxUp: iUp, idxDown: iDown };
  }
  const tokens = market?.tokens;
  if (Array.isArray(tokens) && tokens.length >= 2) {
    const names = tokens.map((t) =>
      normalizeOutcomeLabel(t?.outcome ?? t?.name ?? t?.title ?? t?.label ?? '')
    );
    const iUp = names.findIndex((l) => l === 'up');
    const iDown = names.findIndex((l) => l === 'down');
    if (iUp >= 0 && iDown >= 0) return { idxUp: iUp, idxDown: iDown };
  }
  return { idxUp: 0, idxDown: 1 };
}

function coalesceClobTokenIds(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const out = raw.map((x) => String(x).trim()).filter(Boolean);
    return out.length ? out : null;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return [s];
    try {
      const p = JSON.parse(s);
      if (Array.isArray(p)) {
        const o = p.map((x) => String(x).trim()).filter(Boolean);
        return o.length ? o : null;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** @returns {[number, number]|null} [priceUp, priceDown] */
export function getAlignedUpDownGammaPrices(market) {
  const prices = parseGammaOutcomePricesNumbers(market);
  if (!prices || prices.length < 2) return null;
  const { idxUp, idxDown } = getUpDownOutcomeIndices(market);
  const pU = prices[idxUp];
  const pD = prices[idxDown];
  if (!Number.isFinite(pU) || !Number.isFinite(pD)) return null;
  return [pU, pD];
}

/** @returns {{ tokenIdUp: string|null, tokenIdDown: string|null }} */
export function getAlignedUpDownTokenIds(market) {
  if (!market || typeof market !== 'object') return { tokenIdUp: null, tokenIdDown: null };
  const tokens = Array.isArray(market.tokens) ? market.tokens : [];
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

  const idArr = coalesceClobTokenIds(market.clobTokenIds ?? market.clob_token_ids);
  const { idxUp, idxDown } = getUpDownOutcomeIndices(market);
  const pick = (idx) => {
    const fromArr = idArr?.[idx] != null ? String(idArr[idx]).trim() : null;
    if (fromArr) return fromArr;
    const t = tokens[idx];
    const tid = t?.token_id ?? t?.tokenId;
    return tid != null ? String(tid).trim() : null;
  };
  return { tokenIdUp: pick(idxUp), tokenIdDown: pick(idxDown) };
}

export function getTokenIdForSide(market, takeSide) {
  const { tokenIdUp, tokenIdDown } = getAlignedUpDownTokenIds(market);
  return takeSide === 'Up' ? tokenIdUp : tokenIdDown;
}
