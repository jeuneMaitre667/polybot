import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DEFAULT_BOT_STATUS_URL, useBotStatus } from '@/hooks/useBotStatus.js';

function formatUsd(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(2)} $`;
}

export function BotOverview() {
  const statusUrl = DEFAULT_BOT_STATUS_URL;
  const { data, loading, error } = useBotStatus(statusUrl);

  if (!statusUrl) return null;

  const balance = data?.balanceUsd != null ? Number(data.balanceUsd) : null;
  const orders24h = data?.ordersLast24h ?? null;
  const winRate = data?.winRate != null ? Number(data.winRate) * 100 : null;

  const history = data?.balanceHistory ?? [];
  const firstBalance = history.length > 0 ? Number(history[0].balance) : null;
  const lastBalance = balance != null ? balance : history.length > 0 ? Number(history[history.length - 1].balance) : null;
  const pnl =
    firstBalance != null && lastBalance != null && firstBalance > 0 ? ((lastBalance - firstBalance) / firstBalance) * 100 : null;

  const isOnline = data?.status === 'online';

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card className="border border-border/60 bg-card/90 shadow-card">
        <CardHeader className="pb-1 flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-[0.16em]">
            Solde bot
          </CardTitle>
          <Badge variant={isOnline ? 'secondary' : 'destructive'} className="text-[10px] px-2 py-0.5">
            {loading ? 'Chargement…' : isOnline ? 'En ligne' : error || 'Hors ligne'}
          </Badge>
        </CardHeader>
        <CardContent className="pt-1">
          <p className="text-2xl font-semibold text-emerald-400">
            {balance != null ? formatUsd(balance) : '—'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Mise à jour {data?.at ? new Date(data.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : 'récente'}
          </p>
        </CardContent>
      </Card>

      <Card className="border border-border/60 bg-card/90 shadow-card">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-[0.16em]">
            PnL (période graphique)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-1">
          <p className={`text-2xl font-semibold ${pnl != null && pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)} %` : '—'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Basé sur l’historique de solde disponible
          </p>
        </CardContent>
      </Card>

      <Card className="border border-border/60 bg-card/90 shadow-card">
        <CardHeader className="pb-1">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-[0.16em]">
            Performance 24 h
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-1">
          <p className="text-2xl font-semibold text-slate-50">
            {orders24h != null ? `${orders24h} ordre${orders24h !== 1 ? 's' : ''}` : '—'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Win rate :{' '}
            {winRate != null ? (
              <span className={winRate >= 50 ? 'text-emerald-400 font-medium' : 'text-rose-400 font-medium'}>
                {winRate.toFixed(1)} %
              </span>
            ) : (
              '—'
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

