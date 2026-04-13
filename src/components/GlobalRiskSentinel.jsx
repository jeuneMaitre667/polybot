import React from 'react';
import { DollarSign, ShieldAlert, Activity, LayoutGrid, Server, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';

export function GlobalRiskSentinel({ data, paperBalance, realBalance }) {
  const totalBalance = (paperBalance || 0) + (realBalance || 0);
  const dailyLossLimit = -500;
  
  // Real daily stats from health or status
  const dailyPnL = data?.dailyStats?.totalPnL || 0;
  
  // Progress bar color based on loss
  const progressColor = dailyPnL < -400 ? 'bg-red-500' : dailyPnL < -200 ? 'bg-amber-500' : 'bg-green-500';
  const progressShadow = dailyPnL < -400 ? '0 0 12px rgba(239, 68, 68, 0.4)' : 'none';

  return (
    <div className="glass-panel relative border border-white/5 bg-gradient-to-br from-indigo-500/5 to-emerald-500/5 p-6 rounded-3xl overflow-hidden shadow-2xl">
      <div className="absolute top-0 right-0 p-4 opacity-[0.03] pointer-events-none">
        <ShieldAlert size={180} />
      </div>
      
      <div className="flex flex-wrap items-center justify-between gap-12 2xl:gap-20 relative z-10 transition-all">
        {/* TOTAL BANKROLL */}
        <div className="flex flex-col gap-1 flex-1 min-w-[380px] 2xl:min-w-[450px]">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-blue-400 font-bold mb-1">
            <LayoutGrid size={14} /> Global Bankroll
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl 2xl:text-6xl font-extrabold tracking-tight font-mono text-white transition-all">
              ${totalBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
            <span className="text-xs 2xl:text-sm opacity-40 font-mono">USD</span>
          </div>
          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-1.5 text-[9px] opacity-60">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Paper: ${paperBalance?.toFixed(0) || '—'}
            </div>
            <div className="flex items-center gap-1.5 text-[9px] opacity-60">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" /> Real: ${realBalance?.toFixed(0) || '—'}
            </div>
          </div>
        </div>

        {/* DAILY PERFORMANCE & RISK BRAKE */}
        <div className="flex-[2] min-w-[450px] flex flex-col justify-center px-8 border-l border-white/5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-amber-400 font-bold whitespace-nowrap">
              <ShieldAlert size={14} /> Daily Risk Guard
            </div>
            <div className="flex items-center gap-2 text-[10px] font-mono opacity-60 uppercase tracking-tighter">
              Limit: <span className="text-white font-bold">${dailyLossLimit}</span>
            </div>
          </div>
          
          <div className="relative h-3 bg-white/5 rounded-full overflow-hidden border border-white/5">
             <div 
               className={cn("h-full transition-all duration-500", progressColor)}
               style={{ width: `${Math.min(100, Math.max(0, (dailyPnL / dailyLossLimit) * 100))}%`, boxShadow: progressShadow }}
             />
          </div>
          
          <div className="flex justify-between mt-2 font-mono text-[9px] uppercase tracking-widest">
            <div className="flex items-center gap-2">
              <TrendingUp size={16} className={`transition-all ${dailyPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`} />
              <span className={cn(dailyPnL < 0 ? "text-red-400" : "text-green-400")}>
                Current PnL: {dailyPnL >= 0 ? '+' : ''}${(dailyPnL || 0).toFixed(2)}
              </span>
            </div>
            <span className="opacity-30">Threshold -500</span>
          </div>
        </div>

        {/* SYSTEM CONNECTIVITY */}
        <div className="flex-1 min-w-[300px] flex flex-col gap-3 justify-center border-l border-white/5 pl-8">
           <div className="flex items-center justify-between text-[10px] 2xl:text-[11px] uppercase tracking-widest text-green-400 font-bold mb-1">
             <div className="flex items-center gap-2">
               <Server size={14} /> System Health
             </div>
           </div>
           
           <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-[9px] opacity-40 uppercase">Latency</span>
                <span className="text-xs font-bold font-mono text-white">
                  {data?.health?.tradeLatencyStats?.ws?.lastLatencyMs 
                    ? `${Math.round(data.health.tradeLatencyStats.ws.lastLatencyMs)}ms` 
                    : '—'}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[9px] opacity-40 uppercase">Node</span>
                <span className={cn(
                  "text-[10px] font-bold font-mono",
                  data?.health?.chainlinkSources?.BTC?.rpc?.includes('Alchemy') ? "text-purple-400" : "text-blue-400"
                )}>
                  {data?.health?.chainlinkSources?.BTC?.rpc || 'Polygon RPC'}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[9px] opacity-40 uppercase">Bot</span>
                <span className={cn(
                  "text-[10px] font-bold font-mono flex items-center gap-1",
                  data?.health?.wsConnected || data?.health?.wsLastBidAskAt ? "text-green-400" : "text-red-400"
                )}>
                  <Activity size={10} className={cn(data?.health?.wsConnected && "animate-pulse")} /> 
                  {data?.health?.wsConnected || data?.health?.wsLastBidAskAt ? 'ONLINE' : 'OFFLINE'}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[9px] opacity-40 uppercase">Uptime</span>
                <span className="text-[10px] font-bold font-mono text-white truncate">
                  {data?.health?.uptimeStart 
                    ? `${Math.floor(data.health.uptimeStart / 3600)}h ${Math.floor((data.health.uptimeStart % 3600) / 60)}m` 
                    : 'Active'}
                </span>
              </div>
           </div>
        </div>
      </div>
    </div>
  );
}
