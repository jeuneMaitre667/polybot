import React from 'react';
import { Shield, Target, Unlock, Lock, Percent, TrendingDown, DollarSign } from 'lucide-react';
import { cn } from '@/lib/utils';

export function RiskKellySentinel({ data }) {
  if (!data || !data.health) return null;

  const h = data.health;
  const totalBalance = data.balanceUsd || 0;
  const available = h.availableCapital !== null ? h.availableCapital : totalBalance;
  const locked = Math.max(0, totalBalance - available);
  const lockPct = totalBalance > 0 ? (locked / totalBalance) * 100 : 0;
  
  const dailyPnl = data.dailyPnl ?? 0;
  const dailyLossLimit = 500; // Hardcoded in bot
  const lossPct = Math.min(100, Math.max(0, (Math.abs(dailyPnl) / dailyLossLimit) * 100));
  const isLossCritical = dailyPnl <= -dailyLossLimit * 0.8;

  // Correlation Guard BTC/ETH
  const activePositions = data.activePositions || [];
  const hasBtc = activePositions.some(p => p.underlying === 'BTC' && !p.resolved);
  const hasEth = activePositions.some(p => p.underlying === 'ETH' && !p.resolved);
  const correlationLocked = hasBtc && !hasEth; // Simplified logic visibility

  return (
    <div className="space-y-6">
      <div className="section-title flex items-center gap-4">
        <h2 className="text-xl font-bold tracking-tight text-white/90">Risk & Strategy Sentinel</h2>
        <div className="h-[1px] flex-1 bg-gradient-to-r from-white/10 to-transparent" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* CAPITAL ALLOCATION GAUGE */}
        <div className="card glass-panel border border-white/5 p-6 flex flex-col justify-between">
          <div className="flex justify-between items-start mb-6">
            <div className="space-y-1">
              <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest">Capital Allocation</h3>
              <div className="text-2xl font-bold font-mono tracking-tighter text-white">
                ${Number(available || 0).toFixed(2)} <span className="text-sm font-normal text-white/40">Available</span>
              </div>
            </div>
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
              <DollarSign size={20} />
            </div>
          </div>

          <div className="space-y-3">
            <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden flex">
              <div 
                className="h-full bg-emerald-400 transition-all duration-1000" 
                style={{ width: `${100 - (lockPct || 0)}%` }} 
              />
              <div 
                className="h-full bg-amber-400 transition-all duration-1000" 
                style={{ width: `${lockPct || 0}%` }} 
              />
            </div>
            <div className="flex justify-between text-[10px] font-bold uppercase tracking-wider">
              <span className="text-emerald-400/60">Free: {Number(100 - (lockPct || 0)).toFixed(1)}%</span>
              <span className="text-amber-400/60">Reserved: {Number(lockPct || 0).toFixed(1)}%</span>
            </div>
          </div>
        </div>

        {/* KELLY STRATEGY */}
        <div className="card glass-panel border border-white/5 p-6">
          <div className="flex justify-between items-start mb-6">
            <div className="space-y-1">
              <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest">Kelly Criterion</h3>
              <div className="text-2xl font-bold font-mono tracking-tighter text-white">
                {h.kellyFraction ? `${(Number(h.kellyFraction) * 100).toFixed(0)}%` : '25%'} <span className="text-sm font-normal text-white/40">Fractional</span>
              </div>
            </div>
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400">
              <Target size={20} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="text-[10px] font-bold text-white/20 uppercase tracking-wider">Max Bankroll Pct</div>
              <div className="text-sm font-bold text-white/80">{h.kellyMaxBankrollPct ? `${Number(h.kellyMaxBankrollPct) * 100}%` : '25%'}</div>
            </div>
            <div className="space-y-2">
              <div className="text-[10px] font-bold text-white/20 uppercase tracking-wider">Max Conc. Pos</div>
              <div className="text-sm font-bold text-white/80">{h.maxConcurrentPositions || 1} PER ASSET</div>
            </div>
          </div>
          
          <div className="mt-4 pt-4 border-t border-white/5 flex items-center gap-2">
             <div className="w-2 h-2 rounded-full bg-blue-400 pulse-glow" />
             <span className="text-[9px] font-bold text-blue-400/60 uppercase tracking-tighter">Adaptive Stake Active</span>
          </div>
        </div>

        {/* CORRELATION & CIRCUIT BREAKER */}
        <div className="card glass-panel border border-white/5 p-6">
          <div className="flex justify-between items-start mb-4">
            <div className="space-y-1">
              <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest">Shield Matrix</h3>
              <div className="flex items-center gap-2">
                <span className={cn("text-xs font-bold px-2 py-0.5 rounded uppercase tracking-tighter", 
                  isLossCritical ? "bg-red-500/20 text-red-400" : "bg-emerald-500/20 text-emerald-400")}>
                  Daily Circuit: OK
                </span>
                {correlationLocked && (
                  <span className="text-xs font-bold px-2 py-0.5 bg-amber-500/20 text-amber-400 rounded uppercase tracking-tighter flex items-center gap-1">
                    <Lock size={10} /> BTC/ETH Guard
                  </span>
                )}
              </div>
            </div>
            <div className={cn("p-2 rounded-lg", isLossCritical ? "bg-red-500/10 text-red-400" : "bg-white/5 text-white/40")}>
              <Shield size={20} />
            </div>
          </div>

          <div className="space-y-3 pt-2">
             <div className="flex justify-between items-end mb-1">
                <span className="text-[10px] font-bold text-white/40 uppercase">Daily Loss Progress</span>
                <span className="text-xs font-mono font-bold text-white">${Number(Math.abs(dailyPnl || 0)).toFixed(0)} / ${dailyLossLimit}</span>
             </div>
             <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                <div 
                  className={cn("h-full transition-all duration-1000", isLossCritical ? "bg-red-500" : "bg-white/20")}
                  style={{ width: `${lossPct || 0}%` }}
                />
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}
