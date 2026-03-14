import { formatVolume, getOpportunityCategory, getMarketEndDate } from '../utils/formatters';

export function StatsHeader({ markets, onRefresh, loading }) {
  const total = markets.length;
  const urgentCount = markets.filter((m) => getOpportunityCategory(getMarketEndDate(m)) === 'urgent').length;
  const totalVolume = markets.reduce((acc, m) => acc + (parseFloat(m.volume) || 0), 0);

  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-800/40 shadow-card backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-700/60 text-slate-300">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Marchés actifs</p>
              <p className="text-xl font-bold text-white">{total}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/15 text-rose-400">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Fin &lt; 24h</p>
              <p className="text-xl font-bold text-rose-400">{urgentCount}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Volume total</p>
              <p className="text-xl font-bold text-emerald-400">{formatVolume(totalVolume)}</p>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-900/25 transition hover:bg-emerald-500 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
        >
          {loading ? 'Chargement…' : 'Actualiser'}
        </button>
      </div>
    </div>
  );
}
