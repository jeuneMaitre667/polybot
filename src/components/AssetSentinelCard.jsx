import React from 'react';
import { Target, TrendingUp, Zap, Activity, ShieldCheck, AlertTriangle, Lock, Unlock } from 'lucide-react';
import { cn } from '@/lib/utils';

export function AssetSentinelCard({ asset, data }) {
  if (!data || !data.health) return null;

  const assetState = data.health.assetStates?.[asset] || {};
  const perpData = data.health.perpSources?.[asset] || {};
  const clData = data.health.chainlinkSources?.[asset] || {};
  
  // Consensus Price (Same logic as bot)
  const sources = [perpData.binance, perpData.okx, perpData.hyper].filter(p => p > 0);
  const consensusPrice = sources.length > 0 ? sources.reduce((a, b) => a + b, 0) / sources.length : 0;
  
  const clPrice = clData.lastPrice || 0;
  const drift = consensusPrice > 0 && clPrice > 0 ? ((consensusPrice - clPrice) / clPrice) * 100 : 0;
  
  const vol = assetState.realizedVol60m || 0;
  const volBucket = vol > 0.5 ? 'high' : vol > 0.2 ? 'mid' : 'low';
  const volColor = volBucket === 'high' ? 'text-red-400' : volBucket === 'mid' ? 'text-yellow-400' : 'text-green-400';
  const volBg = volBucket === 'high' ? 'bg-red-400' : volBucket === 'mid' ? 'bg-yellow-400' : 'bg-green-400';

  const isStrikeLocked = assetState.strikeLocked || false;
  const currentSlot = assetState.currentSlot || 'Scan...';

  // Asset Theme Mapping
  const themes = {
    BTC: { color: 'var(--btc-gold)', muted: 'var(--btc-gold-muted)', cardClass: 'card--btc' },
    ETH: { color: 'var(--eth-blue)', muted: 'var(--eth-blue-muted)', cardClass: 'card--eth' },
    SOL: { color: 'var(--sol-purple)', muted: 'var(--sol-purple-muted)', cardClass: 'card--sol' },
  };
  const theme = themes[asset] || themes.BTC;

  return (
    <div className={cn("card relative overflow-hidden transition-all duration-300 hover:scale-[1.02]", theme.cardClass)}>
      <div className="card-glow" style={{ background: `radial-gradient(circle at center, ${theme.color} 0%, transparent 70%)` }} />
      
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-lg" style={{ backgroundColor: theme.muted, color: theme.color, border: `1px solid ${theme.color}33` }}>
            {asset[0]}
          </div>
          <div>
            <h3 className="font-bold text-lg tracking-tight">{asset}</h3>
            <div className="flex items-center gap-1.5 text-[10px] opacity-50 uppercase font-mono tracking-wider">
              <Activity size={10} className="text-blue-400" />
              Real-time Sentinel
            </div>
          </div>
        </div>
        <div className={cn("flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold border", 
          isStrikeLocked ? "bg-green-500/10 border-green-500/20 text-green-400" : "bg-amber-500/10 border-amber-500/20 text-amber-400")}>
          {isStrikeLocked ? <Lock size={10} /> : <Unlock size={10} className="animate-pulse" />}
          {isStrikeLocked ? 'STRIKE LOCKED' : 'SYNCING'}
        </div>
      </div>

      <div className="space-y-4">
        {/* PRICE SECTION */}
        <div className="stat-card bg-white/5 border-white/5">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[10px] opacity-40 uppercase font-mono">Consensus Price</span>
            <TrendingUp size={12} className={Math.abs(drift) > 0.05 ? 'text-amber-400 animate-pulse' : 'opacity-20'} />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono tracking-tighter">${consensusPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            <span className={cn("text-xs font-bold", drift >= 0 ? "text-green-400" : "text-red-400")}>
              {drift >= 0 ? '+' : ''}{drift.toFixed(3)}%
            </span>
          </div>
          <p className="text-[9px] opacity-30 mt-1 uppercase">vs Chainlink Spot (${clPrice.toLocaleString()})</p>
        </div>

        {/* RISK & VOLATILITY */}
        <div className="grid grid-cols-2 gap-3">
          <div className="stat-card bg-white/5 border-white/5 flex flex-col justify-between">
            <span className="text-[10px] opacity-40 uppercase font-mono">Realized Vol</span>
            <div className="flex items-center gap-2 mt-1">
              <span className={cn("text-lg font-bold font-mono", volColor)}>{(vol * 100).toFixed(1)}%</span>
              <div className={cn("w-1.5 h-1.5 rounded-full shadow-[0_0_8px_currentColor]", volBg)} />
            </div>
          </div>
          <div className="stat-card bg-white/5 border-white/5 flex flex-col justify-between">
            <span className="text-[10px] opacity-40 uppercase font-mono">Slot Activity</span>
            <div className="text-sm font-bold font-mono text-blue-300 mt-1 truncate" title={currentSlot}>
              {currentSlot.split('-').pop() || '—'}
            </div>
          </div>
        </div>

        {/* EXCHANGE STATUS PILLS */}
        <div className="flex flex-wrap gap-2 pt-2 border-t border-white/5">
          {['binance', 'okx', 'hyper'].map(exchange => (
            <div key={exchange} className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/5 border border-white/5 text-[9px] font-mono uppercase">
              <div className={cn("w-1 h-1 rounded-full", perpData[exchange] > 0 ? "bg-green-400" : "bg-red-400")} />
              <span className="opacity-60">{exchange}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-[9px] opacity-30 uppercase tracking-widest font-mono">
        <span>Sentinel v5.5.0</span>
        <div className="flex items-center gap-1">
          <ShieldCheck size={10} /> SECURED
        </div>
      </div>
    </div>
  );
}
