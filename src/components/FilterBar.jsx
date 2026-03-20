import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

const selectStyle = {
  height: 36,
  minWidth: 180,
  borderRadius: 10,
  border: '1px solid var(--border)',
  background: 'transparent',
  padding: '0 12px',
  color: 'var(--text-1)',
  fontSize: 13,
  fontFamily: 'JetBrains Mono, monospace',
};

export function FilterBar({
  sortBy,
  onSortChange,
  tagFilter,
  onTagFilterChange,
  tags,
  ratioMin90,
  onRatioMin90Change,
  hideSports,
  onHideSportsChange,
  hideWeather,
  onHideWeatherChange,
  showRecommendations,
  onShowRecommendationsChange,
}) {
  return (
    <div className="card relative overflow-hidden">
      <div
        aria-hidden
        style={{
          pointerEvents: 'none',
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(90deg, rgba(167,139,250,0.12) 0%, rgba(56,189,248,0.00) 45%, rgba(34,197,94,0.10) 100%)',
        }}
      />
      <div className="card-content relative z-10" style={{ padding: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, alignItems: 'flex-start' }}>
          {/* Options — groupe distinct */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 18,
              borderRadius: 12,
              border: '1px solid var(--border)',
              background: 'rgba(255,255,255,0.04)',
              padding: '12px 16px',
              width: '100%',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Checkbox
                id="ratio-90"
                checked={ratioMin90}
                onCheckedChange={(checked) => onRatioMin90Change(checked === true)}
              />
              <Label htmlFor="ratio-90" style={{ cursor: 'pointer' }}>
                Ratio min 90/10
              </Label>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Checkbox
                id="hide-sports"
                checked={hideSports}
                onCheckedChange={(checked) => onHideSportsChange(checked === true)}
              />
              <Label htmlFor="hide-sports" style={{ cursor: 'pointer' }}>
                Masquer les sports
              </Label>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Checkbox
                id="hide-weather"
                checked={hideWeather}
                onCheckedChange={(checked) => onHideWeatherChange(checked === true)}
              />
              <Label htmlFor="hide-weather" style={{ cursor: 'pointer' }}>
                Masquer les météos
              </Label>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Checkbox
                id="recommendations"
                checked={showRecommendations}
                onCheckedChange={(checked) => onShowRecommendationsChange(checked === true)}
              />
              <Label htmlFor="recommendations" style={{ cursor: 'pointer' }}>
                Recommandations (Oui ou Non ≤ 10 %, tri chronologique)
              </Label>
            </div>
          </div>

          {/* Séparateur visuel sur desktop */}
          <div className="filter-bar-divider" aria-hidden />

          {/* Tri et Catégorie — champs alignés */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Label htmlFor="sort" style={{ fontSize: 11 }}>
                Tri
              </Label>
              <select
                id="sort"
                value={sortBy}
                onChange={(e) => onSortChange(e.target.value)}
                style={selectStyle}
              >
                <option value="endDate">Date de fin (proche → lointain)</option>
                <option value="volume">Volume (décroissant)</option>
                <option value="odds">Cote Oui (incertain → certain)</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Label htmlFor="category" style={{ fontSize: 11 }}>
                Catégorie
              </Label>
              <select
                id="category"
                value={tagFilter}
                onChange={(e) => onTagFilterChange(e.target.value)}
                style={selectStyle}
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
      </div>
    </div>
  );
}
