/**
 * Déduplication des lignes backtest Bitcoin Up/Down 15m (clés de créneau Polymarket).
 * En cas de doublon (même slug / même fenêtre d’entrée), on **garde la ligne la plus informative**,
 * notamment celle qui a un **signal simulé** (`botWouldTake`), pour ne pas perdre de signaux.
 */

const SLOT_15M_SEC = 15 * 60;

export function normalizeConditionId(cid) {
  if (!cid) return null;
  const s = String(cid).trim();
  if (/^0x[a-fA-F0-9]{64}$/.test(s)) return s;
  if (/^0x[a-fA-F0-9]+$/.test(s)) return '0x' + s.slice(2).padStart(64, '0');
  if (/^[a-fA-F0-9]{64}$/.test(s)) return '0x' + s;
  if (/^\d+$/.test(s)) {
    const hex = BigInt(s).toString(16);
    return '0x' + hex.padStart(64, '0');
  }
  return null;
}

/** Fin de créneau (ms UTC) depuis le slug Polymarket btc-updown-15m-{unixSec}. */
export function slotEndMsFrom15mSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const m = slug.match(/btc-updown-15m-(\d+)$/i);
  if (!m) return null;
  const ts = parseInt(m[1], 10);
  if (!Number.isFinite(ts)) return null;
  return ts < 1e12 ? ts * 1000 : ts;
}

function resultRowDedupeKey(r) {
  const ms = slotEndMsFrom15mSlug(r.eventSlug ?? '');
  if (ms != null) return `end:${Math.floor(ms / 1000)}`;
  const cid = r.normalizedConditionId ?? normalizeConditionId(r.conditionId);
  if (cid) return `cid:${cid}`;
  if (r.slotEndSec != null && Number.isFinite(r.slotEndSec)) {
    return `end:${Math.round(r.slotEndSec / SLOT_15M_SEC) * SLOT_15M_SEC}`;
  }
  return `misc:${r.eventSlug ?? ''}:${r.conditionId ?? r.question ?? ''}`;
}

function scoreRaw15mResultRow(r) {
  let s = 0;
  if (r?.tokenIdUp) s += 8;
  if (r?.tokenIdDown) s += 2;
  if (r?.winner === 'Up' || r?.winner === 'Down') s += 4;
  if (r?.normalizedConditionId) s += 1;
  return s;
}

function preferRaw15mResultRow(a, b) {
  return scoreRaw15mResultRow(b) > scoreRaw15mResultRow(a) ? b : a;
}

/**
 * Une seule ligne par créneau 15m avant enrichissement.
 * Doublons (ex. slug fetch + liste fermée) : meilleure ligne (tokens + winner).
 */
export function dedupeResultsOnePer15mSlot(resultRows) {
  const byKey = new Map();
  for (const r of resultRows) {
    const k = resultRowDedupeKey(r);
    const prev = byKey.get(k);
    byKey.set(k, prev === undefined ? r : preferRaw15mResultRow(prev, r));
  }
  const out = [];
  const seen = new Set();
  for (const r of resultRows) {
    const k = resultRowDedupeKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(byKey.get(k));
  }
  return out;
}

/**
 * Clé de dédup **par marché / créneau Polymarket**, pas par timestamp d’entrée simulée.
 * Anciennement on utilisait `botEntryTimestamp` en premier : un signal à t peut tomber dans le quart d’heure
 * **suivant** (ou précédent) vs `slotEndSec` du slug → deux lignes fusionnées → mauvais `winner` affiché
 * (ex. Up/Down inversés entre deux créneaux vs le site).
 */
function enrichedRowDedupeKey(e) {
  const slugMs = slotEndMsFrom15mSlug(e.eventSlug ?? '');
  if (slugMs != null) return `slot:${Math.floor(slugMs / 1000)}`;
  if (e.slotEndSec != null && Number.isFinite(e.slotEndSec)) {
    return `slot:${Math.round(e.slotEndSec / SLOT_15M_SEC) * SLOT_15M_SEC}`;
  }
  if (e.botEntryTimestamp != null && Number.isFinite(Number(e.botEntryTimestamp))) {
    const ts = Number(e.botEntryTimestamp);
    const periodStart = Math.floor(ts / SLOT_15M_SEC) * SLOT_15M_SEC;
    return `slot:${periodStart + SLOT_15M_SEC}`;
  }
  const cid = e.normalizedConditionId ?? normalizeConditionId(e.conditionId);
  return cid ? `cid:${cid}` : `row:${e.eventSlug ?? ''}`;
}

function scoreEnriched15mRow(e) {
  let s = 0;
  if (e?.botWouldTake != null) s += 10_000;
  if (e?.botEntryTimestamp != null) s += 1_000;
  const pts = Number(e?.debugHistoryPoints);
  if (Number.isFinite(pts)) s += Math.min(pts, 9_000);
  if (e?.winner === 'Up' || e?.winner === 'Down') s += 100;
  return s;
}

function preferEnriched15mRow(a, b) {
  return scoreEnriched15mRow(b) > scoreEnriched15mRow(a) ? b : a;
}

/**
 * Après simulation : une ligne par **créneau slug** (btc-updown-15m-{fin UTC}).
 * Si deux enrichissements partagent la même clé, on garde celui avec **signal** et le plus de points d’historique.
 */
export function dedupeEnrichedOnePer15mTradeWindow(enrichedRows) {
  const byKey = new Map();
  for (const row of enrichedRows) {
    const k = enrichedRowDedupeKey(row);
    const prev = byKey.get(k);
    byKey.set(k, prev === undefined ? row : preferEnriched15mRow(prev, row));
  }
  const out = [];
  const seen = new Set();
  for (const row of enrichedRows) {
    const k = enrichedRowDedupeKey(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(byKey.get(k));
  }
  return out;
}
