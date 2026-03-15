import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

const inputClass =
  'flex h-10 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';


function formatMoney(value) {
  if (Number.isNaN(value) || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// Simulateur horaire : 1 période = 1 heure

export function CompoundInterestCalculator() {
  const [principal15, setPrincipal15] = useState(1000);
  const [ratePercent15, setRatePercent15] = useState(5);
  const [hours15, setHours15] = useState(24);

  const {
    finalAmount15,
    interestEarned15,
    chartData15,
    examplePeriods15,
  } = useMemo(() => {
    const P = Number(principal15) || 0;
    const r = (Number(ratePercent15) || 0) / 100;
    const totalHours = Number(hours15) || 0;
    const n = Math.max(0, totalHours); // nombre d'heures (1 période = 1 heure)
    if (P <= 0 || n <= 0) {
      return {
        finalAmount15: 0,
        interestEarned15: 0,
        chartData15: [],
        examplePeriods15: [],
      };
    }
    const A = P * Math.pow(1 + r, n);
    const data = [];
    const step = Math.max(0.25, n / 80);
    for (let h = 0; h <= n; h += step) {
      const m = Math.round(P * Math.pow(1 + r, h) * 100) / 100;
      data.push({ heure: Math.round(h * 100) / 100, montant: m });
    }
    if (data[data.length - 1]?.heure !== n) {
      data.push({ heure: n, montant: A });
    }
    const examplePeriods15 = [];
    let montantVeille = P;
    for (let h = 1; h <= Math.min(5, n); h++) {
      const nouveau = Math.round(montantVeille * (1 + r) * 100) / 100;
      examplePeriods15.push({ heure: h, montantVeille, montant: nouveau });
      montantVeille = nouveau;
    }
    return {
      finalAmount15: A,
      interestEarned15: A - P,
      chartData15: data,
      examplePeriods15,
    };
  }, [principal15, ratePercent15, hours15]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-lg">Simulation par heure</CardTitle>
          <p className="text-sm text-muted-foreground">
            Chaque heure vous faites X % et vous réinvestissez le tout pour l&apos;heure suivante.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="principal-15">Mise de départ (€)</Label>
              <input
                id="principal-15"
                type="number"
                min="0"
                step="100"
                value={principal15}
                onChange={(e) => setPrincipal15(Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rate-15">Gain par heure (%)</Label>
              <input
                id="rate-15"
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={ratePercent15}
                onChange={(e) => setRatePercent15(Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="hours-15">Durée (heures)</Label>
            <input
              id="hours-15"
              type="number"
              min="1"
              step="1"
              value={hours15}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                setHours15(Number.isNaN(v) || v < 1 ? 1 : v);
              }}
              className={inputClass}
            />
          </div>

          <div className="rounded-lg border border-border/50 bg-muted/20 p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Montant final</span>
              <span className="text-xl font-bold text-primary">{formatMoney(finalAmount15)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Gains totaux</span>
              <span className="font-semibold text-foreground">{formatMoney(interestEarned15)}</span>
            </div>
          </div>

          {examplePeriods15.length > 0 && (
            <div className="rounded-lg border border-border/50 bg-muted/10 p-4 space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Exemple : chaque heure = précédent + {ratePercent15} %</p>
              <ul className="text-sm text-muted-foreground space-y-1.5">
                <li>Heure 1 : {formatMoney(examplePeriods15[0].montantVeille)} + {ratePercent15} % = {formatMoney(examplePeriods15[0].montant)}</li>
                {examplePeriods15.slice(1).map(({ heure, montantVeille, montant }) => (
                  <li key={heure}>
                    Heure {heure} : {formatMoney(montantVeille)} + {ratePercent15} % = {formatMoney(montant)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {chartData15.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Évolution (axe : heures)</p>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData15} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="fillMontant15" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis
                      dataKey="heure"
                      tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                      tickFormatter={(v) => `${v} h`}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                      tickFormatter={(v) => {
                      if (v == null || !Number.isFinite(v) || v < 0) return '0';
                      if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M €`;
                      return `${(v / 1000).toFixed(0)}k €`;
                    }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'hsl(var(--card))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                      }}
                      labelStyle={{ color: 'hsl(var(--foreground))' }}
                      formatter={(value) => [formatMoney(value), 'Montant']}
                      labelFormatter={(label) => `${label} h`}
                    />
                    <Area
                      type="monotone"
                      dataKey="montant"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      fill="url(#fillMontant15)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
