import React from 'react';
import { Target, TrendingUp, Zap, Activity, Link2, ShieldCheck, AlertTriangle } from 'lucide-react';

export function ArbitrageMonitor({ data }) {
  if (!data || !data.liveArbitrage) return null;

  const { 
    btc, strike, fair, poly, gap, vol, secondsLeft, 
    priceSource, netGapUp, netGapDown, adaptiveThreshold, 
    volBucket, priceImpact, chainlinkAge 
  } = data.liveArbitrage;
  
  // Le GAP affiché est maintenant le Net Gap maximum entre Up et Down
  const netGap = Math.max(netGapUp || 0, netGapDown || 0);
  const hasStrike = strike != null && strike > 0;
  const isStale = chainlinkAge === 'stale' || btc === 0;

  const gapPct = (netGap * 100).toFixed(2);
  const thresholdPct = (adaptiveThreshold * 100).toFixed(2);
  const isHighGap = netGap >= adaptiveThreshold && !isStale;

  const volPct = vol != null ? (vol * 100).toFixed(1) : '—';
  const fairDisplay = fair != null ? (fair * 100).toFixed(1) : '—';
  
  // Style selon le bucket de volatilité
  const volColor = volBucket === 'high' ? 'text-red-400' : volBucket === 'mid' ? 'text-yellow-400' : 'text-green-400';

  return (
    <div className="arbitrage-monitor glass-panel">
      <div className="panel-header">
        <Activity className="icon-pulse text-blue-400" size={18} />
        <h3 className="text-sm font-semibold tracking-wider uppercase opacity-80">Arbitrage Engine 2.1 (HFT)</h3>
        {isHighGap && (
          <span className="badge badge-error ml-auto animate-pulse">
            <Zap size={12} fill="currentColor" /> NET OPPORTUNITY
          </span>
        )}
        {isStale && (
          <span className="badge badge-warning ml-auto">
            <AlertTriangle size={12} /> STALE PRICE
          </span>
        )}
      </div>

      {/* Status Bar */}
      <div className="mt-2 flex items-center justify-between text-[10px] border-b border-white/5 pb-2">
        <div className="flex items-center gap-2">
          <ShieldCheck size={10} className={isStale ? 'text-gray-500' : 'text-green-400'} />
          <span className={isStale ? 'text-red-400 font-bold' : 'text-green-400 opacity-80'}>
            {isStale ? 'SAFETY STOP ACTIVE' : 'ENGINE SECURED'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="opacity-40">Source: <span className="text-blue-300 font-mono">{priceSource}</span></span>
          <span className="opacity-40">Skew: <span className="text-purple-300 font-mono">-3.0%</span></span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
        {/* NET GAP GAUGE */}
        <div className="stat-card relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs opacity-60 uppercase">Net GAP (Post-Fees)</span>
            <TrendingUp size={14} className={isHighGap ? 'text-red-400' : 'opacity-40'} />
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className={`text-3xl font-bold ${isStale ? 'text-gray-600' : isHighGap ? 'text-red-400' : 'text-green-400'}`}>
              {gapPct}%
            </span>
            <span className="text-[10px] opacity-40">target {thresholdPct}%</span>
          </div>
          <div className="text-[9px] opacity-30 mt-1 uppercase italic">Incl. Dyn Fees (Rate 0.072) & Spread</div>
          <div className="progress-bar-bg mt-2">
            <div 
              className={`progress-bar-fill ${isHighGap ? 'bg-red-500' : 'bg-green-500'}`} 
              style={{ width: `${Math.min(100, (parseFloat(gapPct) / parseFloat(thresholdPct)) * 100)}%` }}
            />
          </div>
        </div>

        {/* BTC VS STRIKE */}
        <div className="stat-card">
          <div className="flex items-center justify-between">
            <span className="text-xs opacity-60 uppercase">Price Reference</span>
            <Target size={14} className="opacity-40" />
          </div>
          <div className="mt-2 space-y-1">
            <div className="flex justify-between items-center text-[11px]">
              <span className="opacity-50">Spot</span>
              <span className={`font-mono ${isStale ? 'text-red-400' : 'text-blue-300'}`}>${btc?.toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center text-[11px]">
              <span className="opacity-50">Strike</span>
              <span className="font-mono text-white">${strike?.toLocaleString()}</span>
            </div>
            <div className="pt-1 mt-1 border-t border-white/5 flex justify-between text-[10px]">
              <span className="opacity-40">Impact ($300)</span>
              <span className="text-yellow-500">-{priceImpact?.toFixed(4)}</span>
            </div>
          </div>
        </div>

        {/* PROBABILITY */}
        <div className="stat-card">
          <div className="flex items-center justify-between">
            <span className="text-xs opacity-60 uppercase">Skewed Fair Prob</span>
            <Activity size={14} className="opacity-40" />
          </div>
          <div className="flex flex-col items-center justify-center h-full -mt-2">
            <div className="text-2xl font-bold text-blue-400">{fairDisplay}%</div>
            <div className="text-[10px] opacity-40 mt-1 uppercase tracking-tighter">Market Efficiency</div>
          </div>
        </div>

        {/* ADAPTIVE RISK */}
        <div className="stat-card">
          <div className="flex items-center justify-between">
            <span className="text-xs opacity-60 uppercase">Adaptive Risk</span>
            <Zap size={14} className={volColor} />
          </div>
          <div className="mt-1">
            <span className={`text-2xl font-bold ${volColor}`}>{volPct}%</span>
            <span className="text-[10px] ml-2 opacity-40">ANN. VOL</span>
          </div>
          <div className="text-[10px] mt-2 opacity-50 flex items-center gap-1 capitalize">
            <div className={`w-1.5 h-1.5 rounded-full ${volColor.replace('text', 'bg')}`}></div>
            {volBucket} Regimetype
          </div>
        </div>
      </div>
      
      <div className="mt-4 pt-3 border-t border-white/5 flex justify-between items-center">
        <div className="text-[10px] opacity-40 flex items-center gap-2 font-mono">
          <span className={`w-2 h-2 rounded-full ${isStale ? 'bg-red-500' : 'bg-green-500'} animate-pulse`}></span>
          LATENCY: {isStale ? 'BLOCKED' : '< 100ms (Alchemy)'} | MODE: 15m_QUICK_STRIKE
        </div>
        <div className="text-[10px] font-mono opacity-60 bg-white/5 px-2 py-0.5 rounded">
          T-MINUS: {Math.floor(secondsLeft / 60)}m {Math.floor(secondsLeft % 60)}s
        </div>
      </div>
    </div>
  );
}
