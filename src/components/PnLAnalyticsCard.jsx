import React from 'react';
import { TrendingUp, TrendingDown, Target, BarChart3, Activity } from 'lucide-react';
import { cn } from '@/lib/utils';

export function PnLAnalyticsCard({ performance }) {
  const p = performance || {};
  const netProfit = p.netProfit || 0;
  const winRatePct = p.winRatePct || 0;
  const totalVolume = p.totalVolume || 0;
  const tradeCount = p.tradeCount || 0;
  const profitFactor = p.profitFactor || 0;
  const avgWin = p.avgWin || 0;
  const avgLoss = p.avgLoss || 0;
  const updatedAt = p.updatedAt || new Date().toISOString();

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
          <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 flex items-center justify-center text-indigo-400 border border-indigo-500/20">
            <BarChart3 size={24} />
          </div>
          <div>
            <h2 className="text-xl font-black tracking-tight text-white uppercase italic">Intelligence Hub v17.3</h2>
            <p className="text-[10px] text-white/30 font-mono tracking-widest uppercase">Deep Performance Analytics</p>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 flex-1">
          {/* NET PROFIT */}
          <div className="bg-white/[0.03] border border-white/5 p-5 rounded-2xl hover:bg-white/[0.05] transition-all duration-300">
            <div className="flex justify-between items-center mb-3">
              <span className="text-[11px] text-white/40 uppercase font-mono tracking-widest">Net Session Profit</span>
              {isProfitable ? <TrendingUp size={16} className="text-green-400" /> : <TrendingDown size={16} className="text-red-400" />}
            </div>
            <div className="flex items-baseline gap-2 overflow-hidden">
              <span className={cn("text-2xl 2xl:text-4xl font-black font-mono tracking-tighter transition-all truncate", isProfitable ? "text-green-400" : "text-red-400")}>
                {isProfitable ? '+' : ''}{(netProfit || 0).toFixed(2)}
              </span>
              <span className="text-[10px] 2xl:text-xs font-mono text-white/20 uppercase shrink-0">USDC</span>
            </div>
            <div className="mt-4 flex flex-col gap-1">
                <div className="flex justify-between items-center">
                    <span className="text-[9px] text-white/30 uppercase">Avg Win</span>
                    <span className="text-[10px] text-green-400 font-mono">+${avgWin}</span>
                </div>
                <div className="flex justify-between items-center">
                    <span className="text-[9px] text-white/30 uppercase">Avg Loss</span>
                    <span className="text-[10px] text-red-400 font-mono">-${avgLoss}</span>
                </div>
            </div>
          </div>

          {/* PROFIT FACTOR */}
          <div className="bg-white/[0.03] border border-white/5 p-5 rounded-2xl hover:bg-white/[0.05] transition-all duration-300">
            <div className="flex justify-between items-center mb-3">
              <span className="text-[11px] text-white/40 uppercase font-mono tracking-widest">Profit Factor</span>
              <Activity size={16} className="text-indigo-400" />
            </div>
            <div className="flex items-baseline gap-2 overflow-hidden">
              <span className={cn("text-2xl 2xl:text-4xl font-black font-mono tracking-tighter transition-all truncate", profitFactor >= 1.5 ? "text-indigo-400" : "text-white/60")}>
                {profitFactor}
              </span>
              <span className="text-[10px] 2xl:text-xs font-mono text-white/20 uppercase shrink-0">Ratio</span>
            </div>
            <div className="w-full h-1.5 bg-white/5 rounded-full mt-4 overflow-hidden">
              <div 
                className={cn("h-full transition-all duration-1000", profitFactor >= 2 ? "bg-indigo-400 shadow-[0_0_10px_rgba(129,140,248,0.5)]" : "bg-white/20")}
                style={{ width: `${Math.min(100, (profitFactor / 3) * 100)}%` }} 
              />
            </div>
          </div>

          {/* WIN RATE */}
          <div className="bg-white/[0.03] border border-white/5 p-5 rounded-2xl hover:bg-white/[0.05] transition-all duration-300">
            <div className="flex justify-between items-center mb-3">
              <span className="text-[11px] text-white/40 uppercase font-mono tracking-widest">Execution Edge</span>
              <Target size={16} className="text-blue-400" />
            </div>
            <div className="flex items-baseline gap-2 overflow-hidden">
              <span className="text-2xl 2xl:text-4xl font-black font-mono tracking-tighter text-white transition-all truncate">
                {winRatePct}%
              </span>
              <span className="text-[10px] 2xl:text-xs font-mono text-white/20 uppercase shrink-0">Win Rate</span>
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
                <span className="text-[10px] font-mono text-white/20 uppercase">Total Trades</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 pt-4 border-t border-white/5 flex justify-between items-center">
          <p className="text-[10px] text-white/20 font-mono tracking-widest uppercase">
            Source: trades-history.json | Refresh: 30s | Intelligence: Node-Engine
          </p>
          <p className="text-[10px] text-white/20 font-mono">
            Last Intelligence Sync: {new Date(updatedAt).toLocaleTimeString()}
          </p>
        </div>
      </div>
    </div>
  );
}
