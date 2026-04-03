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
    <div className="space-y-6">
      <div className="section-title flex items-center gap-4">
        <h2 className="text-xl font-bold tracking-tight text-white/90">Node & Latency Sentinel</h2>
        <div className="h-[1px] flex-1 bg-gradient-to-r from-white/10 to-transparent" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4 gap-6">
        {/* WS LATENCY */}
        <div className={cn("card glass-panel border border-white/5 p-5 space-y-4 min-w-[240px] flex-shrink-0 transition-all", getSeverityBg(ws.avgMs))}>
          <div className="flex justify-between items-start">
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400">
              <Zap size={20} />
            </div>
            <div className="text-[10px] font-bold text-white/40 uppercase tracking-widest">WS Latency</div>
          </div>
          <div>
            <div className={cn("text-3xl font-bold font-mono tracking-tighter", getSeverityColor(ws.avgMs))}>
              {formatMs(ws.avgMs)}
            </div>
            <p className="text-[10px] opacity-40 mt-1 uppercase">Avg 24h • P95: {formatMs(ws.p95Ms)}</p>
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-white/5 text-[9px] uppercase font-bold opacity-40">
             <div className={cn("w-1.5 h-1.5 rounded-full animate-pulse", ws.count > 0 ? "bg-emerald-400" : "bg-red-400")} />
             {ws.count} samples captured
          </div>
        </div>

        {/* REST LATENCY */}
        <div className={cn("card glass-panel border border-white/5 p-5 space-y-4 min-w-[240px] flex-shrink-0 transition-all", getSeverityBg(poll.avgMs))}>
          <div className="flex justify-between items-start">
            <div className="p-2 rounded-lg bg-purple-500/10 text-purple-400">
              <Server size={20} />
            </div>
            <div className="text-[10px] font-bold text-white/40 uppercase tracking-widest">REST Poll</div>
          </div>
          <div>
            <div className={cn("text-3xl font-bold font-mono tracking-tighter", getSeverityColor(poll.avgMs))}>
              {formatMs(poll.avgMs)}
            </div>
            <p className="text-[10px] opacity-40 mt-1 uppercase">Avg 24h • P95: {formatMs(poll.p95Ms)}</p>
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-white/5 text-[9px] uppercase font-bold opacity-40">
             <div className={cn("w-1.5 h-1.5 rounded-full", (data.chainlinkSources?.BTC?.rpc || '').includes('Alchemy') ? "bg-emerald-400" : "bg-purple-400")} />
             {data.chainlinkSources?.BTC?.rpc || 'Public Fallback'}
          </div>
        </div>

        {/* CYCLE SPEED */}
        <div className="card glass-panel border border-white/5 p-5 space-y-4 min-w-[240px] flex-shrink-0 transition-all">
          <div className="flex justify-between items-start">
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
              <Timer size={20} />
            </div>
            <div className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Cycle Speed</div>
          </div>
          <div>
            <div className="text-3xl font-bold font-mono tracking-tighter text-white/90">
              {formatMs(cycleLatency.avgMs)}
            </div>
            <p className="text-[10px] opacity-40 mt-1 uppercase">Loop Interval • P95: {formatMs(cycleLatency.p95Ms)}</p>
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-white/5 text-[9px] uppercase font-bold opacity-40">
             <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
             Engine Heartbeat Active
          </div>
        </div>

        {/* CACHE PERFORMANCE */}
        <div className="card glass-panel border border-white/5 p-5 space-y-4 min-w-[240px] flex-shrink-0 transition-all">
          <div className="flex justify-between items-start">
            <div className="p-2 rounded-lg bg-orange-500/10 text-orange-400">
              <Activity size={20} />
            </div>
            <div className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Pre-Sign Edge</div>
          </div>
          <div>
            <div className="text-3xl font-bold font-mono tracking-tighter text-white/90">
              {tradeLatency.preSignCacheHitRate != null ? `${tradeLatency.preSignCacheHitRate}%` : '—'}
            </div>
            <p className="text-[10px] opacity-40 mt-1 uppercase">Cache Hit Rate • {tradeLatency.preSignCacheHits}/{tradeLatency.preSignCacheTotal}</p>
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-white/5 text-[9px] uppercase font-bold opacity-40">
             <div className="w-1.5 h-1.5 rounded-full bg-orange-400" />
             Optimization 5.3.0
          </div>
        </div>
      </div>

      {/* DETAILED BREAKDOWN GRID */}
      <div className="flex flex-wrap gap-4 items-center justify-start lg:justify-between">
        {[
          { label: 'Best Ask', key: 'bestAsk', icon: Target },
          { label: 'Creds', key: 'creds', icon: ShieldCheck },
          { label: 'Balance', key: 'balance', icon: Briefcase },
          { label: 'OrderBook', key: 'book', icon: Network },
          { label: 'Placement', key: 'placeOrder', icon: Zap },
        ].map((item) => {
          const IconComponent = item.icon;
          const stats = breakdown.all?.[item.key] || {};
          return (
            <div key={item.key} className="glass-panel border border-white/5 px-4 py-3 rounded-xl flex items-center gap-6 hover:bg-white/5 transition-all duration-300 group min-w-[160px]">
              <div className="flex items-center gap-3">
                <div className="text-white/20 group-hover:text-blue-400 transition-colors"><IconComponent size={16} /></div>
                <span className="text-[10px] 2xl:text-[11px] font-bold text-white/60 uppercase tracking-tighter">{item.label}</span>
              </div>
              <span className={cn("text-xs 2xl:text-sm font-bold font-mono transition-all", getSeverityColor(stats.avgMs))}>
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
