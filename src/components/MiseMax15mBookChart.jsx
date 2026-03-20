import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
    <div style={{ marginTop: 16, width: '100%', height: 220 }}>
      <p style={{ marginBottom: 8, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace' }}>
        Historique par créneau (fin UTC → mise max $ en 97–97,5 %)
      </p>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 32 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 9, fill: 'var(--text-2)' }}
            interval="preserveStartEnd"
            angle={-35}
            textAnchor="end"
            height={48}
            axisLine={{ stroke: 'transparent' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'var(--text-2)' }}
            width={44}
            domain={[0, Math.ceil(maxVal * 1.1)]}
            tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`)}
            axisLine={{ stroke: 'transparent' }}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 12,
              color: 'var(--text-1)',
            }}
            formatter={(value) => [`${Number(value).toFixed(2)} $`, 'Mise max']}
          />
          <Bar dataKey="miseMaxUsd" radius={[4, 4, 0, 0]} maxBarSize={14}>
            {data.map((d, idx) => (
              <Cell key={idx} fill={d.miseMaxUsd > 0 ? 'var(--green)' : 'var(--red)'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
