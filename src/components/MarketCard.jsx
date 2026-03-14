import { formatVolume, formatPercent, formatTimeUntil, getOpportunityCategory, getMarketEndDate } from '../utils/formatters';

const OPPORTUNITY_LABELS = {
  urgent: { label: 'Urgent', bg: 'bg-rose-500/15', text: 'text-rose-400', border: 'border-rose-500/30' },
  soon: { label: 'Bientôt', bg: 'bg-amber-500/15', text: 'text-amber-400', border: 'border-amber-500/30' },
  normal: { label: 'Normal', bg: 'bg-emerald-500/15', text: 'text-emerald-400', border: 'border-emerald-500/30' },
};

export function MarketCard({ market }) {
  const eventSlug = market.eventSlug ?? '';
  const marketSlug = market.slug ?? '';
  const question = market.question ?? 'Sans titre';
  const endDate = getMarketEndDate(market);
  const volume = market.volume ?? '0';
  const outcomePrices = (() => {
    try {
      const parsed = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      return Array.isArray(parsed) ? parsed : ['0.5', '0.5'];
    } catch {
      return ['0.5', '0.5'];
    }
  })();
  const outcomes = (() => {
    try {
      const parsed = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      return Array.isArray(parsed) ? parsed : ['Yes', 'No'];
    } catch {
      return ['Yes', 'No'];
    }
  })();

  const yesPct = parseFloat(outcomePrices[0]) || 0.5;
  const noPct = parseFloat(outcomePrices[1]) ?? 1 - yesPct;
  const category = getOpportunityCategory(endDate);
  const { label: oppLabel, bg: oppBg, text: oppText, border: oppBorder } = OPPORTUNITY_LABELS[category];

  const polymarketUrl = eventSlug
    ? `https://polymarket.com/event/${eventSlug}`
    : marketSlug
      ? `https://polymarket.com/market/${marketSlug}`
      : '#';

  return (
    <a
      href={polymarketUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group block rounded-2xl border border-slate-700/50 bg-slate-800/40 p-5 shadow-card transition hover:border-emerald-500/30 hover:bg-slate-800/60 hover:shadow-card-hover"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${oppBg} ${oppText} ${oppBorder}`}>
          {oppLabel}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-slate-500">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {formatTimeUntil(endDate)}
        </span>
      </div>
      <h3 className="mb-4 line-clamp-2 text-base font-semibold leading-snug text-slate-100 group-hover:text-white">
        {question}
      </h3>
      <div className="mb-4 flex items-baseline gap-2">
        <span className="text-sm text-slate-500">Volume</span>
        <span className="text-lg font-bold text-emerald-400">{formatVolume(volume)}</span>
      </div>
      <div className="space-y-2.5">
        <div className="flex justify-between text-sm font-medium">
          <span className="text-emerald-400">{outcomes[0] ?? 'Yes'} {formatPercent(yesPct)}</span>
          <span className="text-rose-400">{outcomes[1] ?? 'No'} {formatPercent(noPct)}</span>
        </div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-700">
          <div
            className="rounded-l-full bg-emerald-500 transition-all duration-300"
            style={{ width: `${yesPct * 100}%` }}
          />
          <div
            className="rounded-r-full bg-rose-500 transition-all duration-300"
            style={{ width: `${noPct * 100}%` }}
          />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-1.5 text-xs text-slate-500 group-hover:text-emerald-400">
        <span>Ouvrir sur Polymarket</span>
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </div>
    </a>
  );
}
