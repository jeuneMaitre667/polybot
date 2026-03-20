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

/** Token CLOB Up (0) / Down (1) depuis un objet marché Gamma. */
export function parseUpDownTokenIdsFromMarket(m) {
  if (!m || typeof m !== 'object') return { tokenIdUp: null, tokenIdDown: null };
  const idArr = coalesceClobTokenIds(m.clobTokenIds ?? m.clob_token_ids);
  const tokens = m.tokens;
  const tokenIdUp = idArr?.[0] ?? (Array.isArray(tokens) && tokens[0]?.token_id ? String(tokens[0].token_id) : null);
  const tokenIdDown = idArr?.[1] ?? (Array.isArray(tokens) && tokens[1]?.token_id ? String(tokens[1].token_id) : null);
  return { tokenIdUp, tokenIdDown };
}
