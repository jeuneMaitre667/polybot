import { formatVolume, formatPercent, formatTimeUntil, getOpportunityCategory, getMarketEndDate } from '../utils/formatters';
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
    <a href={polymarketUrl} target="_blank" rel="noopener noreferrer" className="market-card-link">
      <div className="relative h-full overflow-hidden market-card-surface rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-sm">
        <div
          aria-hidden
          style={{
            pointerEvents: 'none',
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(135deg, rgba(167,139,250,0.12) 0%, rgba(56,189,248,0.00) 45%, rgba(34,197,94,0.10) 100%)',
          }}
        />
        <div className="relative z-10 p-5">
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <Badge variant={OPPORTUNITY_VARIANTS[category]} className={cn(category === 'soon' && 'badge--secondary')}>
              {oppLabel}
            </Badge>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)' }}>
              <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {formatTimeUntil(endDate)}
            </span>
          </div>
          <h3 style={{ marginBottom: 16, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 16, fontWeight: 700, lineHeight: 1.25 }}>
            {question}
          </h3>
          <div style={{ marginBottom: 16, display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 13, color: 'var(--text-2)' }}>Volume</span>
            <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--blue)' }}>{formatVolume(volume)}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600 }}>
              <span style={{ color: 'var(--blue)' }}>{outcomes[0] ?? 'Yes'} {formatPercent(yesPct)}</span>
              <span style={{ color: 'var(--red)' }}>{outcomes[1] ?? 'No'} {formatPercent(noPct)}</span>
            </div>
            <div style={{ display: 'flex', height: 10, overflow: 'hidden', borderRadius: 999, background: 'rgba(255,255,255,0.06)' }}>
              <div
                style={{
                  borderRadius: '999px 0 0 999px',
                  background: 'var(--blue-muted)',
                  transition: 'width 300ms ease',
                  width: `${yesPct * 100}%`,
                }}
              />
              <div
                style={{
                  borderRadius: '0 999px 999px 0',
                  background: 'var(--red-muted)',
                  transition: 'width 300ms ease',
                  width: `${noPct * 100}%`,
                }}
              />
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, fontSize: 12, color: 'var(--text-2)' }}>
            <span>Ouvrir sur Polymarket</span>
            <svg style={{ width: 16, height: 16 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </div>
        </div>
      </div>
    </a>
  );
}
