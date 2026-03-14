import { useState, useMemo } from 'react';
import { useMarkets } from './hooks/useMarkets';
import { getMarketEndTime, getMarketEndDate, getOpportunityCategory } from './utils/formatters';
import { StatsHeader } from './components/StatsHeader';
import { FilterBar } from './components/FilterBar';
import { MarketCard } from './components/MarketCard';
import { LoadingSpinner } from './components/LoadingSpinner';

function normalizeTagSlug(s) {
  if (s == null || s === '') return '';
  return String(s).toLowerCase().replace(/\s+/g, '-');
}

function getUniqueTags(markets) {
  const seen = new Set();
  const tags = [];
  for (const m of markets) {
    const list = m.tags ?? [];
    for (const t of list) {
      const rawSlug = t?.slug ?? t?.label ?? t;
      const slug = normalizeTagSlug(rawSlug);
      const label = t?.label ?? t?.slug ?? rawSlug ?? '';
      if (slug && !seen.has(slug)) {
        seen.add(slug);
        tags.push({ slug, label: String(label) });
      }
    }
  }
  return tags.sort((a, b) => (a.label || a.slug).localeCompare(b.label || b.slug));
}

function parseYesPrice(market) {
  try {
    const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    return parseFloat(prices?.[0]) ?? 0.5;
  } catch {
    return 0.5;
  }
}

/** Retourne true si les deux issues (Oui et Non) sont au moins à 3 %. */
function hasMinOutcome3Pct(market) {
  try {
    const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    if (!Array.isArray(prices) || prices.length < 2) return false;
    const a = parseFloat(prices[0]) ?? 0;
    const b = parseFloat(prices[1]) ?? 0;
    return a >= 0.03 && b >= 0.03;
  } catch {
    return false;
  }
}

/** Retourne true si le marché a un ratio au moins 90/10 (une issue ≥ 90 %, l’autre ≤ 10 %). */
function hasRatioMin90_10(market) {
  try {
    const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    if (!Array.isArray(prices) || prices.length < 2) return false;
    const a = parseFloat(prices[0]) ?? 0.5;
    const b = parseFloat(prices[1]) ?? 0.5;
    const maxP = Math.max(a, b);
    const minP = Math.min(a, b);
    return maxP >= 0.9 && minP <= 0.1;
  } catch {
    return false;
  }
}

export default function App() {
  const { markets, loading, error, refresh } = useMarkets();
  const [sortBy, setSortBy] = useState('endDate');
  const [volumeMin, setVolumeMin] = useState(0);
  const [tagFilter, setTagFilter] = useState('');
  const [ratioMin90, setRatioMin90] = useState(true);

  const tags = useMemo(() => getUniqueTags(markets), [markets]);

  const filteredAndSorted = useMemo(() => {
    const now = new Date();
    const startOfTodayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let list = [...markets].filter((m) => {
      const endTs = getMarketEndTime(m);
      if (endTs == null) return true;
      return endTs >= startOfTodayUTC;
    });
    list = list.filter((m) => (parseFloat(m.volume) || 0) >= volumeMin);
    list = list.filter(hasMinOutcome3Pct);
    if (ratioMin90) list = list.filter(hasRatioMin90_10);
    if (tagFilter) {
      const tagSlug = String(tagFilter).toLowerCase();
      list = list.filter((m) =>
        (m.tags ?? []).some((t) => {
          const s = (t?.slug ?? t?.label ?? t);
          return s != null && String(s).toLowerCase().replace(/\s+/g, '-') === tagSlug;
        })
      );
    }
    const urgencyOrder = { urgent: 0, soon: 1, normal: 2 };
    const getUrgency = (m) => urgencyOrder[getOpportunityCategory(getMarketEndDate(m))] ?? 2;

    list.sort((a, b) => {
      const urgencyA = getUrgency(a);
      const urgencyB = getUrgency(b);
      if (urgencyA !== urgencyB) return urgencyA - urgencyB;

      if (sortBy === 'endDate') return (getMarketEndTime(a) ?? 0) - (getMarketEndTime(b) ?? 0);
      if (sortBy === 'volume') return parseFloat(b.volume) - parseFloat(a.volume);
      if (sortBy === 'odds') {
        const yesA = parseYesPrice(a);
        const yesB = parseYesPrice(b);
        return Math.abs(0.5 - yesA) - Math.abs(0.5 - yesB);
      }
      return 0;
    });
    return list;
  }, [markets, sortBy, volumeMin, tagFilter, ratioMin90]);

  return (
    <div className="min-h-screen text-slate-200">
      <header className="border-b border-slate-700/50 bg-slate-900/50 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">
            <span className="text-emerald-400">Polymarket</span>
            <span className="text-slate-300"> — Tableau de bord</span>
          </h1>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <StatsHeader markets={filteredAndSorted} onRefresh={refresh} loading={loading} />
        <div className="mt-6">
          <FilterBar
            sortBy={sortBy}
            onSortChange={setSortBy}
            volumeMin={volumeMin}
            onVolumeMinChange={setVolumeMin}
            tagFilter={tagFilter}
            onTagFilterChange={setTagFilter}
            tags={tags}
            ratioMin90={ratioMin90}
            onRatioMin90Change={setRatioMin90}
          />
        </div>

        {error && (
          <div className="mt-6 rounded-xl border border-rose-500/30 bg-rose-500/10 px-5 py-4 text-rose-300 shadow-card">
            {error}
          </div>
        )}

        {loading && filteredAndSorted.length === 0 ? (
          <LoadingSpinner />
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {filteredAndSorted.map((market) => (
              <MarketCard key={market.id ?? market.slug ?? market.question} market={market} />
            ))}
          </div>
        )}

        {!loading && filteredAndSorted.length === 0 && !error && (
          <div className="mt-12 rounded-2xl border border-slate-700/50 bg-slate-800/30 py-16 text-center">
            <p className="text-slate-400">Aucun marché ne correspond aux filtres.</p>
            <p className="mt-1 text-sm text-slate-500">Essayez d’élargir vos critères.</p>
          </div>
        )}
      </main>
    </div>
  );
}
