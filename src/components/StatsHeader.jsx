import { formatVolume, getOpportunityCategory, getMarketEndDate } from '../utils/formatters';
import { Button } from '@/components/ui/button';

export function StatsHeader({ markets, onRefresh, loading }) {
  const total = markets.length;
  const urgentCount = markets.filter((m) => getOpportunityCategory(getMarketEndDate(m)) === 'urgent').length;
  const totalVolume = markets.reduce((acc, m) => acc + (parseFloat(m.volume) || 0), 0);

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
      <div className="card-content relative z-10">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.06)', color: 'var(--text-2)' }}>
                <svg style={{ width: 20, height: 20 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </div>
              <div>
                <p className="card-label" style={{ marginBottom: 4 }}>Marchés actifs</p>
                <p className="card-value" style={{ fontSize: 22 }}>{total}</p>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,61,107,0.12)', color: 'var(--red)' }}>
                <svg style={{ width: 20, height: 20 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <p className="card-label" style={{ marginBottom: 4 }}>Fin &lt; 24h</p>
                <p className="card-value red" style={{ fontSize: 22 }}>{urgentCount}</p>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(77,159,255,0.12)', color: 'var(--blue)' }}>
                <svg style={{ width: 20, height: 20 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <p className="card-label" style={{ marginBottom: 4 }}>Volume total</p>
                <p className="card-value amber" style={{ fontSize: 22 }}>{formatVolume(totalVolume)}</p>
              </div>
            </div>
          </div>
          <Button
            onClick={onRefresh}
            disabled={loading}
            size="default"
            className="btn"
            variant="secondary"
          >
            {loading ? 'Chargement…' : 'Actualiser'}
          </Button>
        </div>
      </div>
    </div>
  );
}
