import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

const selectClass =
  'flex h-9 min-w-[180px] rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

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
    <Card className="relative overflow-hidden border-border/50 bg-card/80 backdrop-blur-sm">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-violet-500/10 via-sky-500/0 to-emerald-500/10"
      />
      <CardContent className="relative z-10 p-5 sm:p-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:flex-wrap sm:items-end">
          {/* Options — groupe distinct */}
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border/50 bg-muted/30 px-4 py-3 sm:py-2.5 sm:gap-6">
            <div className="flex items-center gap-3">
              <Checkbox
                id="ratio-90"
                checked={ratioMin90}
                onCheckedChange={(checked) => onRatioMin90Change(checked === true)}
              />
              <Label htmlFor="ratio-90" className="cursor-pointer text-sm font-medium text-foreground">
                Ratio min 90/10
              </Label>
            </div>
            <div className="flex items-center gap-3">
              <Checkbox
                id="hide-sports"
                checked={hideSports}
                onCheckedChange={(checked) => onHideSportsChange(checked === true)}
              />
              <Label htmlFor="hide-sports" className="cursor-pointer text-sm font-medium text-foreground">
                Masquer les sports
              </Label>
            </div>
            <div className="flex items-center gap-3">
              <Checkbox
                id="hide-weather"
                checked={hideWeather}
                onCheckedChange={(checked) => onHideWeatherChange(checked === true)}
              />
              <Label htmlFor="hide-weather" className="cursor-pointer text-sm font-medium text-foreground">
                Masquer les météos
              </Label>
            </div>
            <div className="flex items-center gap-3">
              <Checkbox
                id="recommendations"
                checked={showRecommendations}
                onCheckedChange={(checked) => onShowRecommendationsChange(checked === true)}
              />
              <Label htmlFor="recommendations" className="cursor-pointer text-sm font-medium text-foreground">
                Recommandations (Oui ou Non ≤ 10 %, tri chronologique)
              </Label>
            </div>
          </div>

          {/* Séparateur visuel sur desktop */}
          <div className="hidden h-9 w-px bg-border sm:block" aria-hidden />

          {/* Tri et Catégorie — champs alignés */}
          <div className="flex flex-wrap items-end gap-4 sm:gap-6">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sort" className="text-xs font-medium text-muted-foreground">
                Tri
              </Label>
              <select
                id="sort"
                value={sortBy}
                onChange={(e) => onSortChange(e.target.value)}
                className={selectClass}
              >
                <option value="endDate">Date de fin (proche → lointain)</option>
                <option value="volume">Volume (décroissant)</option>
                <option value="odds">Cote Oui (incertain → certain)</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="category" className="text-xs font-medium text-muted-foreground">
                Catégorie
              </Label>
              <select
                id="category"
                value={tagFilter}
                onChange={(e) => onTagFilterChange(e.target.value)}
                className={selectClass}
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
      </CardContent>
    </Card>
  );
}
