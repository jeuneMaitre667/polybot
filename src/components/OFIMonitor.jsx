import React from 'react';
import { Activity, ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export function OFIMonitor({ data }) {
  const assetStates = data?.health?.assetStates || {};
  const assets = ['BTC', 'ETH', 'SOL'];

  return (
    <div className="glass-panel border border-white/5 bg-black/40 rounded-2xl overflow-hidden shadow-2xl p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-indigo-400">
          <Activity size={14} /> Order Flow Imbalance (OFI)
        </div>
        <div className="text-[10px] opacity-40 uppercase font-mono px-2 py-0.5 rounded-full bg-white/5">
          Momentum Indicator
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6">
        {assets.map(asset => {
          const score = assetStates[asset]?.ofiScore || 0;
          const isPositive = score > 0.05;
          const isNegative = score < -0.05;
          const absScore = Math.abs(score);
          
          // Color based on momentum strength
          const colorClass = isPositive ? 'text-emerald-400' : isNegative ? 'text-red-400' : 'text-white/60';
          const bgClass = isPositive ? 'bg-emerald-500/10' : isNegative ? 'bg-red-500/10' : 'bg-white/5';
          const borderClass = isPositive ? 'border-emerald-500/20' : isNegative ? 'border-red-500/20' : 'border-white/5';

          return (
            <div key={asset} className={cn("flex items-center gap-4 p-4 rounded-xl border transition-all duration-300", bgClass, borderClass)}>
              <div className="w-12 text-sm font-bold font-mono text-white opacity-80">{asset}</div>
              
              <div className="flex-1 h-2 bg-white/5 rounded-full relative overflow-hidden">
                <div 
                  className={cn("absolute h-full transition-all duration-700", isPositive ? "bg-emerald-400 left-1/2" : isNegative ? "bg-red-400 right-1/2" : "hidden")}
                  style={{ width: `${Math.min(50, absScore * 2)}%` }} // Scaling the score for visiblity
                />
                <div className="absolute top-0 left-1/2 w-0.5 h-full bg-white/20" />
              </div>

              <div className={cn("w-20 text-right font-mono text-[11px] font-bold flex items-center justify-end gap-1.5", colorClass)}>
                {isPositive && <ArrowUp size={12} />}
                {isNegative && <ArrowDown size={12} />}
                {score.toFixed(2)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 pt-4 border-t border-white/5 text-[9px] opacity-30 flex justify-between uppercase tracking-tighter italic">
        <span>Positive: Buy Pressure</span>
        <span>Negative: Sell Pressure</span>
      </div>
    </div>
  );
}
