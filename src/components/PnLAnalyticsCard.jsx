import React from 'react';
import { TrendingUp, TrendingDown, Target, BarChart3, Activity } from 'lucide-react';
import { cn } from '@/lib/utils';

export function PnLAnalyticsCard({ performance }) {
  const { netProfit, winRatePct, totalVolume, tradeCount, updatedAt } = performance || {
    netProfit: 0,
    winRatePct: 0,
    totalVolume: 0,
    tradeCount: 0,
    updatedAt: new Date().toISOString()
  };

  const isProfitable = netProfit >= 0;
  
  return (
    <div className="card bg-gradient-to-br from-slate-900/80 to-slate-800/80 border-white/5 p-8 rounded-3xl backdrop-blur-2xl relative overflow-hidden group mx-auto max-w-[1720px]">
      {/* Heartbeat Badge */}
      <div className="absolute top-0 right-0 p-4">
        <div className="flex items-center gap-2 px-3 py-1 bg-green-500/10 border border-green-500/20 rounded-full">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
          <span className="text-[10px] font-black text-green-400 uppercase tracking-widest">System Heartbeat</span>
        </div>
      </div>

      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-12 h-12 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-400 border border-blue-500/20">
            <BarChart3 size={24} />
          </div>
          <div>
            <h2 className="text-xl font-black tracking-tight text-white uppercase">Operational Performance</h2>
            <p className="text-[10px] text-white/30 font-mono tracking-widest uppercase">Real-time Session Analytics</p>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 flex-1">
          {/* NET PROFIT */}
          <div className="bg-white/[0.03] border border-white/5 p-5 rounded-2xl hover:bg-white/[0.05] transition-all duration-300">
            <div className="flex justify-between items-center mb-3">
              <span className="text-[11px] text-white/40 uppercase font-mono tracking-widest">Net Session Profit</span>
              {isProfitable ? <TrendingUp size={16} className="text-green-400" /> : <TrendingDown size={16} className="text-red-400" />}
            </div>
            <div className="flex items-baseline gap-2">
              <span className={cn("text-4xl 2xl:text-6xl font-black font-mono tracking-tighter transition-all", isProfitable ? "text-green-400" : "text-red-400")}>
                {isProfitable ? '+' : ''}{netProfit.toFixed(2)}
              </span>
              <span className="text-sm 2xl:text-base font-mono text-white/20 uppercase">USDC</span>
            </div>
            <p className="text-[10px] text-white/20 mt-2 font-mono">After Polymarket Fees (0.72%)</p>
          </div>

          {/* WIN RATE */}
          <div className="bg-white/[0.03] border border-white/5 p-5 rounded-2xl hover:bg-white/[0.05] transition-all duration-300">
            <div className="flex justify-between items-center mb-3">
              <span className="text-[11px] text-white/40 uppercase font-mono tracking-widest">Execution Edge</span>
              <Target size={16} className="text-blue-400" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl 2xl:text-6xl font-black font-mono tracking-tighter text-white transition-all">
                {winRatePct}%
              </span>
              <span className="text-sm 2xl:text-base font-mono text-white/20 uppercase">Win Rate</span>
            </div>
            <div className="w-full h-1.5 bg-white/5 rounded-full mt-4 overflow-hidden">
              <div 
                className="h-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)] transition-all duration-1000" 
                style={{ width: `${winRatePct}%` }} 
              />
            </div>
          </div>

          {/* VOLUME & TRADES */}
          <div className="bg-white/[0.03] border border-white/5 p-5 rounded-2xl hover:bg-white/[0.05] transition-all duration-300">
            <div className="flex justify-between items-center mb-3">
              <span className="text-[11px] text-white/40 uppercase font-mono tracking-widest">Throughput</span>
              <Activity size={16} className="text-amber-400" />
            </div>
            <div className="space-y-1">
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-black font-mono tracking-tighter text-amber-400">
                  ${totalVolume.toLocaleString()}
                </span>
                <span className="text-xs font-mono text-white/20 uppercase">Volume</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-bold font-mono tracking-tighter text-white/80">
                  {tradeCount}
                </span>
                <span className="text-[10px] font-mono text-white/20 uppercase">Filled Signals</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 pt-4 border-t border-white/5 flex justify-between items-center">
          <p className="text-[10px] text-white/20 font-mono tracking-widest uppercase">
            Data Source: orders.log | Refresh Interval: 60s
          </p>
          <p className="text-[10px] text-white/20 font-mono">
            Last Compute: {new Date(updatedAt).toLocaleTimeString()}
          </p>
        </div>
      </div>
    </div>
  );
}
