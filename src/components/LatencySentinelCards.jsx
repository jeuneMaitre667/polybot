import React from 'react';
import { Gauge, Zap, Clock, Activity, AlertCircle, Timer, Server, Network, Target } from 'lucide-react';
import { cn } from '@/lib/utils';

export function LatencySentinelCards({ data }) {
  if (!data) return null;

  const tradeLatency = data.tradeLatencyStats || {};
  const breakdown = data.tradeLatencyBreakdownStats || {};
  const cycleLatency = data.cycleLatencyStats || {};

  const ws = tradeLatency.ws || {};
  const poll = tradeLatency.poll || {};
  
  const formatMs = (ms) => ms != null ? `${Math.round(ms)} ms` : '—';
  
  const getSeverityColor = (ms) => {
    if (ms == null) return 'text-white/20';
    if (ms < 100) return 'text-emerald-400';
    if (ms < 300) return 'text-amber-400';
    return 'text-red-400';
  };

  const getSeverityBg = (ms) => {
    if (ms == null) return 'bg-white/5';
    if (ms < 100) return 'bg-emerald-500/10';
    if (ms < 300) return 'bg-amber-500/10';
    return 'bg-red-500/10';
  };

  return (
    <div className="space-y-8">
      <div className="section-title flex items-center gap-4">
        <h2 className="text-xl font-black tracking-tighter text-white/90 uppercase">Infrastructure Sentinel</h2>
        <div className="h-[1px] flex-1 bg-gradient-to-r from-blue-500/20 to-transparent" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {/* WS LATENCY */}
        <div className={cn("card rounded-[2rem] border border-white/5 p-8 transition-all relative overflow-hidden group min-h-[220px]", getSeverityBg(ws.avgMs))}>
          <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 blur-[40px] -mr-12 -mt-12 group-hover:bg-blue-500/10 transition-colors" />
          <div className="flex justify-between items-start relative z-10">
            <div className="p-3 rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-500">
              <Zap size={20} />
            </div>
            <div className="text-[10px] font-black text-white/20 uppercase tracking-[0.3em]">Network Stream</div>
          </div>
          <div className="relative z-10 mt-6">
            <div className={cn("text-4xl font-mono font-black tracking-tighter", getSeverityColor(ws.avgMs))}>
              {formatMs(ws.avgMs)}
            </div>
            <p className="text-[10px] text-white/20 mt-2 uppercase font-bold tracking-widest">Global Avg • P95: {formatMs(ws.p95Ms)}</p>
          </div>
          <div className="flex items-center gap-3 pt-6 mt-auto border-t border-white/5 text-[9px] uppercase font-black tracking-[0.2em] text-white/20 relative z-10">
             <div className={cn("w-2 h-2 rounded-full animate-pulse", ws.count > 0 ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" : "bg-red-500")} />
             {ws.count} Signals Audited
          </div>
        </div>

        {/* REST LATENCY */}
        <div className={cn("card rounded-[2rem] border border-white/5 p-8 transition-all relative overflow-hidden group min-h-[220px]", getSeverityBg(poll.avgMs))}>
          <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 blur-[40px] -mr-12 -mt-12" />
          <div className="flex justify-between items-start relative z-10">
            <div className="p-3 rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-500">
              <Server size={20} />
            </div>
            <div className="text-[10px] font-black text-white/20 uppercase tracking-[0.3em]">Query Engine</div>
          </div>
          <div className="relative z-10 mt-6">
            <div className={cn("text-4xl font-mono font-black tracking-tighter", getSeverityColor(poll.avgMs))}>
              {formatMs(poll.avgMs)}
            </div>
            <p className="text-[10px] text-white/20 mt-2 uppercase font-bold tracking-widest">Active Provider • P95: {formatMs(poll.p95Ms)}</p>
          </div>
          <div className="flex items-center gap-3 pt-6 mt-auto border-t border-white/5 text-[9px] uppercase font-black tracking-[0.2em] text-white/20 relative z-10">
             <div className={cn("w-2 h-2 rounded-full", (data.chainlinkSources?.BTC?.rpc || '').includes('Alchemy') ? "bg-emerald-500" : "bg-blue-500/40")} />
             {data.chainlinkSources?.BTC?.rpc || 'Primary Node Cluster'}
          </div>
        </div>

        {/* HEARTBEAT */}
        <div className="card rounded-[2rem] border border-white/5 p-8 bg-white/[0.01] relative overflow-hidden group min-h-[220px]">
          <div className="flex justify-between items-start relative z-10">
            <div className="p-3 rounded-2xl bg-white/5 border border-white/10 text-white/40 group-hover:text-blue-500 transition-colors">
              <Timer size={20} />
            </div>
            <div className="text-[10px] font-black text-white/20 uppercase tracking-[0.3em]">Heartbeat</div>
          </div>
          <div className="relative z-10 mt-6">
            <div className="text-4xl font-mono font-black tracking-tighter text-white/90">
              {formatMs(cycleLatency.avgMs)}
            </div>
            <p className="text-[10px] text-white/20 mt-2 uppercase font-bold tracking-widest">Cycle Speed • Range: {formatMs(cycleLatency.p95Ms)}</p>
          </div>
          <div className="flex items-center gap-3 pt-6 mt-auto border-t border-white/5 text-[9px] uppercase font-black tracking-[0.2em] text-white/20 relative z-10">
             <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
             Pipeline Nominal
          </div>
        </div>
      </div>

      {/* DETAILED BREAKDOWN GRID */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {[
          { label: 'Market Feed', key: 'bestAsk', icon: Target },
          { label: 'Security', key: 'creds', icon: ShieldCheck },
          { label: 'Liquidity', key: 'balance', icon: Briefcase },
          { label: 'OrderBook', key: 'book', icon: Network },
          { label: 'Execution', key: 'placeOrder', icon: Zap },
        ].map((item) => {
          const IconComponent = item.icon;
          const stats = breakdown.all?.[item.key] || {};
          return (
            <div key={item.key} className="p-5 rounded-[1.5rem] bg-white/[0.01] border border-white/5 flex flex-col gap-4 hover:bg-white/[0.03] hover:border-blue-500/10 transition-all duration-300 group">
              <div className="flex items-center justify-between">
                <div className="text-white/20 group-hover:text-blue-500 transition-colors"><IconComponent size={16} /></div>
                <span className="text-[9px] font-black text-white/20 uppercase tracking-[0.2em]">{item.label}</span>
              </div>
              <span className={cn("text-xl font-mono font-black tracking-tight transition-all", getSeverityColor(stats.avgMs))}>
                {formatMs(stats.avgMs)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ShieldCheck({ size }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-shield-check"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>;
}

function Briefcase({ size }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-briefcase"><path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/></svg>;
}
