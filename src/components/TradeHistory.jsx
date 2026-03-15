import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { useWallet } from '../context/WalletContext';
import { useTradeHistory } from '../hooks/useTradeHistory';

function formatDate(ts) {
  if (ts == null) return '—';
  const d = typeof ts === 'number' ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date(ts);
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function formatPrice(p) {
  if (p == null || Number.isNaN(p)) return '—';
  return `${(Number(p) * 100).toFixed(1)} %`;
}

export function TradeHistory() {
  const { address } = useWallet();
  const { trades, loading, error, refresh } = useTradeHistory(address, { limit: 100 });

  return (
    <Card className="border border-border/60 bg-card/90 backdrop-blur-md shadow-xl shadow-black/10 rounded-2xl overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-xl font-semibold tracking-tight">Historique des trades</CardTitle>
            <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
              Trades exécutés sur Polymarket pour le wallet connecté (Data API).
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-2">
        {!address ? (
          <p className="text-sm text-muted-foreground">Connecte ton wallet pour afficher l&apos;historique des trades.</p>
        ) : error ? (
          <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Chargement des trades…</p>
        ) : trades.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun trade trouvé pour ce wallet.</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border/50">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Date</th>
                    <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Marché</th>
                    <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Côté</th>
                    <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Outcome</th>
                    <th className="text-right py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Taille</th>
                    <th className="text-right py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Prix</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t, i) => (
                    <tr
                      key={t.transactionHash ? `${t.transactionHash}-${i}` : `trade-${i}`}
                      className="border-b border-border/40 hover:bg-muted/20 transition-colors"
                    >
                      <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">{formatDate(t.timestamp)}</td>
                      <td className="py-3 px-3 max-w-[200px] truncate" title={t.title || t.slug}>
                        {t.title || t.slug || '—'}
                      </td>
                      <td className="py-3 px-3">
                        <span className={t.side === 'BUY' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                          {t.side === 'BUY' ? 'Achat' : 'Vente'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-muted-foreground">{t.outcome ?? '—'}</td>
                      <td className="py-3 px-3 text-right font-medium">{t.size != null ? Number(t.size).toFixed(2) : '—'}</td>
                      <td className="py-3 px-3 text-right">{formatPrice(t.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{trades.length} trade(s) affiché(s)</span>
              <button
                type="button"
                onClick={refresh}
                disabled={loading}
                className="rounded-xl border border-border px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50"
              >
                Rafraîchir
              </button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
