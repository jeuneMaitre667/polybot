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
    <div className={cn("card relative overflow-hidden transition-all duration-500 hover:scale-[1.03] hover:shadow-2xl hover:shadow-white/5", theme.cardClass)}>
      <div className="card-glow" style={{ background: `radial-gradient(circle at center, ${theme.color} 0%, transparent 70%)` }} />
      
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 2xl:w-16 2xl:h-16 rounded-2xl flex items-center justify-center font-black text-xl 2xl:text-3xl shadow-lg transition-all" style={{ backgroundColor: theme.muted, color: theme.color, border: `1px solid ${theme.color}44` }}>
            {asset[0]}
          </div>
          <div>
            <h3 className="font-black text-xl tracking-tighter uppercase">{asset}</h3>
            <div className="flex items-center gap-1.5 text-[10px] opacity-60 uppercase font-mono tracking-widest">
              <Activity size={10} className="text-blue-400" />
              Sentinel Active
            </div>
          </div>
        </div>
        <div className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-black border transition-all duration-500", 
          isStrikeLocked ? "bg-green-500/20 border-green-500/40 text-green-400 shadow-[0_0_12px_rgba(74,222,128,0.2)]" : "bg-amber-500/10 border-amber-500/20 text-amber-400")}>
          {isStrikeLocked ? <Lock size={10} /> : <Unlock size={10} className="animate-pulse" />}
          {isStrikeLocked ? 'LOCKED' : 'SYNCING'}
        </div>
      </div>

      <div className="space-y-6">
        {/* PRICE SECTION */}
        <div className="stat-card bg-white/[0.03] border-white/[0.05] p-5 rounded-2xl">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[10px] opacity-50 uppercase font-mono tracking-widest">Consensus Price</span>
            <TrendingUp size={14} className={cn("transition-all", Math.abs(drift) > 0.05 ? 'text-amber-400 animate-pulse' : 'opacity-20')} />
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-3xl 2xl:text-5xl font-black font-mono tracking-tighter text-white transition-all">
              ${consensusPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className={cn("text-sm font-black px-2 py-0.5 rounded", drift >= 0 ? "text-green-400 bg-green-400/10" : "text-red-400 bg-red-400/10")}>
              {drift >= 0 ? '+' : ''}{drift.toFixed(3)}%
            </span>
          </div>
          <p className="text-[10px] font-mono opacity-30 mt-2 uppercase tracking-tight">Oracle Spot: ${clPrice.toLocaleString()}</p>
        </div>

        {/* RISK & VOLATILITY */}
        <div className="grid grid-cols-2 gap-4">
          <div className="stat-card bg-white/[0.03] border-white/[0.05] p-4 rounded-xl flex flex-col justify-between">
            <span className="text-[10px] opacity-50 uppercase font-mono tracking-widest">Realized Vol</span>
            <div className="flex items-center gap-2 mt-2">
              <span className={cn("text-xl font-black font-mono", volColor)}>{(vol * 100).toFixed(1)}%</span>
              <div className={cn("w-2 h-2 rounded-full shadow-[0_0_10px_currentColor]", volBg)} />
            </div>
          </div>
          <div className="stat-card bg-white/[0.03] border-white/[0.05] p-4 rounded-xl flex flex-col justify-between">
            <span className="text-[10px] opacity-50 uppercase font-mono tracking-widest">Slot Activity</span>
            <div className="text-base font-black font-mono text-blue-300 mt-2 truncate max-w-full" title={currentSlot}>
              {currentSlot.split('-').pop() || 'ACTIVE SCAN'}
            </div>
          </div>
        </div>

        {/* EXCHANGE STATUS PILLS */}
        <div className="flex flex-wrap gap-2 pt-4 border-t border-white/5">
          {['binance', 'okx', 'hyper'].map(exchange => (
            <div key={exchange} className={cn("flex items-center gap-2 px-2.5 py-1 rounded-lg border text-[10px] font-mono uppercase transition-all", 
              perpData[exchange] > 0 ? "bg-green-500/5 border-green-500/10 text-green-400/70" : "bg-red-500/5 border-red-500/10 text-red-400/70")}>
              <div className={cn("w-1.5 h-1.5 rounded-full", perpData[exchange] > 0 ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.4)]" : "bg-red-400")} />
              <span>{exchange}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between text-[10px] opacity-30 uppercase tracking-widest font-mono">
        <span>Sentinel v6.2.3</span>
        <div className="flex items-center gap-1.5">
          <ShieldCheck size={12} className="text-green-500/50" /> SECURED
        </div>
      </div>
    </div>
  );
}
