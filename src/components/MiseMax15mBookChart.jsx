import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * @param {{ series: Array<{ slotEndSec: number, miseMaxUsd: number }> }} props
 * Ordre d’affichage : du plus ancien créneau (gauche) au plus récent (droite).
 */
export function MiseMax15mBookChart({ series }) {
  const data = useMemo(() => {
    if (!Array.isArray(series) || series.length === 0) return [];
    return [...series]
      .filter((r) => r && Number.isFinite(Number(r.slotEndSec)))
      .sort((a, b) => Number(a.slotEndSec) - Number(b.slotEndSec))
      .map((r) => {
        const t = Number(r.slotEndSec) * 1000;
        const d = new Date(t);
        return {
          slotEndSec: r.slotEndSec,
          miseMaxUsd: Math.round(Number(r.miseMaxUsd) * 100) / 100,
          label: d.toLocaleString('fr-FR', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
        };
      });
  }, [series]);

  if (data.length === 0) return null;

  const maxVal = Math.max(...data.map((d) => d.miseMaxUsd), 1);

  return (
    <div className="mt-4 w-full" style={{ height: 220 }}>
      <p className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        Historique par créneau (fin UTC → mise max $ en 97–97,5 %)
      </p>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 32 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
            interval="preserveStartEnd"
            angle={-35}
            textAnchor="end"
            height={48}
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            width={44}
            domain={[0, Math.ceil(maxVal * 1.1)]}
            tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`)}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(value) => [`${Number(value).toFixed(2)} $`, 'Mise max']}
          />
          <Bar dataKey="miseMaxUsd" fill="rgb(245 158 11 / 0.75)" radius={[4, 4, 0, 0]} maxBarSize={14} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
