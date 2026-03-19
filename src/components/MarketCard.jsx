import { formatVolume, formatPercent, formatTimeUntil, getOpportunityCategory, getMarketEndDate } from '../utils/formatters';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const OPPORTUNITY_VARIANTS = {
  urgent: 'destructive',
  soon: 'secondary',
  normal: 'default',
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
  const oppLabel = { urgent: 'Urgent', soon: 'Bientôt', normal: 'Normal' }[category];

  const polymarketUrl = eventSlug
    ? `https://polymarket.com/event/${eventSlug}`
    : marketSlug
      ? `https://polymarket.com/market/${marketSlug}`
      : '#';

  return (
    <a href={polymarketUrl} target="_blank" rel="noopener noreferrer" className="group block">
      <Card className="relative h-full overflow-hidden border-border/50 bg-card/80 transition hover:border-primary/30 hover:bg-card">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-500/10 via-cyan-500/0 to-emerald-500/10"
        />
        <CardContent className="relative z-10 p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <Badge variant={OPPORTUNITY_VARIANTS[category]} className={cn(category === 'soon' && 'bg-amber-500/15 text-amber-400 border-amber-500/30')}>
              {oppLabel}
            </Badge>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {formatTimeUntil(endDate)}
            </span>
          </div>
          <h3 className="mb-4 line-clamp-2 text-base font-semibold leading-snug text-foreground">
            {question}
          </h3>
          <div className="mb-4 flex items-baseline gap-2">
            <span className="text-sm text-muted-foreground">Volume</span>
            <span className="text-lg font-bold text-primary">{formatVolume(volume)}</span>
          </div>
          <div className="space-y-2.5">
            <div className="flex justify-between text-sm font-medium">
              <span className="text-primary">{outcomes[0] ?? 'Yes'} {formatPercent(yesPct)}</span>
              <span className="text-destructive">{outcomes[1] ?? 'No'} {formatPercent(noPct)}</span>
            </div>
            <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
              <div
                className="rounded-l-full bg-primary transition-all duration-300"
                style={{ width: `${yesPct * 100}%` }}
              />
              <div
                className="rounded-r-full bg-destructive transition-all duration-300"
                style={{ width: `${noPct * 100}%` }}
              />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-end gap-1.5 text-xs text-muted-foreground group-hover:text-primary">
            <span>Ouvrir sur Polymarket</span>
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </div>
        </CardContent>
      </Card>
    </a>
  );
}
