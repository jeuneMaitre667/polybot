export function FilterBar({
  sortBy,
  onSortChange,
  volumeMin,
  onVolumeMinChange,
  tagFilter,
  onTagFilterChange,
  tags,
  ratioMin90,
  onRatioMin90Change,
}) {
  const inputClass =
    'rounded-xl border border-slate-600/60 bg-slate-700/50 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/25 transition';

  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-800/40 p-5 shadow-card backdrop-blur-sm sm:p-6">
      <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-500">Filtres</p>
      <div className="flex flex-wrap items-center gap-6">
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-600/50 bg-slate-700/30 px-4 py-2.5 transition hover:bg-slate-700/50">
          <input
            type="checkbox"
            checked={ratioMin90}
            onChange={(e) => onRatioMin90Change(e.target.checked)}
            className="h-4 w-4 rounded border-slate-500 bg-slate-600 text-emerald-500 focus:ring-emerald-500/50"
          />
          <span className="text-sm font-medium text-slate-300">Ratio min 90/10</span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-slate-500">Tri</span>
          <select
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value)}
            className={inputClass}
          >
            <option value="endDate">Date de fin (proche → lointain)</option>
            <option value="volume">Volume (décroissant)</option>
            <option value="odds">Cote Oui (incertain → certain)</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-slate-500">Volume min</span>
          <input
            type="range"
            min={0}
            max={1_000_000}
            step={10_000}
            value={volumeMin}
            onChange={(e) => onVolumeMinChange(Number(e.target.value))}
            className="h-2 w-28 rounded-full bg-slate-600 accent-emerald-500"
          />
          <span className="min-w-[3.5rem] text-sm font-medium text-slate-400">
            ${(volumeMin / 1000).toFixed(0)}k
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-slate-500">Catégorie</span>
          <select
            value={tagFilter}
            onChange={(e) => onTagFilterChange(e.target.value)}
            className={inputClass}
          >
            <option value="">Toutes</option>
            {tags.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
