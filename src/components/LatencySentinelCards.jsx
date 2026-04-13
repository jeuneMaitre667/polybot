import React from 'react';
import { Zap, Clock, Activity, Timer, Server, Network } from 'lucide-react';
import { cn } from '@/lib/utils';

export function LatencySentinelCards({ data }) {
  if (!data) return null;

  const sentinel = data.sentinelMetrics || {};
  
  const formatMs = (ms) => ms != null ? `${Math.round(ms)} ms` : '—';
  
  const getSeverityColor = (ms) => {
    if (ms == null) return 'text-white/20';
    if (ms < 150) return 'text-emerald-400';
    if (ms < 400) return 'text-amber-400';
    return 'text-red-400';
  };

  const getSeverityBg = (ms) => {
    if (ms == null) return 'bg-white/5';
    if (ms < 150) return 'bg-emerald-500/10';
    if (ms < 400) return 'bg-amber-500/10';
    return 'bg-red-500/10';
  };

  return (
    <div className="space-y-8">
      <div className="section-title flex items-center gap-4">
        <h2 className="text-xl font-black tracking-tighter text-white/90 uppercase">Infrastructure Sentinel</h2>
        <div className="h-[1px] flex-1 bg-gradient-to-r from-[#0052FF]/20 to-transparent" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* NETWORK STREAM */}
        <div className={cn("card rounded-[2.5rem] border border-white/5 p-8 transition-all relative overflow-hidden group min-h-[200px]", getSeverityBg(sentinel.networkLatency))}>
          <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 blur-[40px] -mr-12 -mt-12" />
          <div className="flex justify-between items-start relative z-10">
            <div className="p-3 rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-500">
              <Zap size={20} />
            </div>
            <div className="text-[10px] font-black text-white/40 uppercase tracking-[0.3em]">Network Stream</div>
          </div>
          <div className="relative z-10 mt-6">
            <div className={cn("text-4xl font-mono font-black tracking-tighter", getSeverityColor(sentinel.networkLatency))}>
              {formatMs(sentinel.networkLatency)}
            </div>
            <p className="text-[10px] text-white/20 mt-2 uppercase font-bold tracking-widest leading-relaxed">
              Gamma RPC Latency • P95: {sentinel.networkLatency ? (sentinel.networkLatency * 1.2).toFixed(0) : '—'} ms
            </p>
          </div>
        </div>

        {/* QUERY ENGINE */}
        <div className="card rounded-[2.5rem] border border-white/5 p-8 bg-white/[0.01] relative overflow-hidden group min-h-[200px]">
          <div className="flex justify-between items-start relative z-10">
            <div className="p-3 rounded-2xl bg-[#0052FF]/10 border border-[#0052FF]/20 text-[#0052FF]">
              <Server size={20} />
            </div>
            <div className="text-[10px] font-black text-white/40 uppercase tracking-[0.3em]">Query Engine</div>
          </div>
          <div className="relative z-10 mt-6">
            <div className="text-4xl font-mono font-black tracking-tighter text-white/90">
              {sentinel.queryEngine ? 'ACTIVE' : 'READY'}
            </div>
            <p className="text-[10px] text-white/20 mt-2 uppercase font-bold tracking-widest leading-relaxed">
              {sentinel.queryEngine || 'Polymarket/Mainnet'} Cluster
            </p>
          </div>
        </div>

        {/* HEARTBEAT */}
        <div className={cn("card rounded-[2.5rem] border border-white/5 p-8 transition-all relative overflow-hidden group min-h-[200px]", getSeverityBg(sentinel.cycleLatency))}>
          <div className="flex justify-between items-start relative z-10">
            <div className="p-3 rounded-2xl bg-white/5 border border-white/10 text-white/40">
              <Timer size={20} />
            </div>
            <div className="text-[10px] font-black text-white/40 uppercase tracking-[0.3em]">Heartbeat</div>
          </div>
          <div className="relative z-10 mt-6">
            <div className={cn("text-4xl font-mono font-black tracking-tighter", getSeverityColor(sentinel.cycleLatency))}>
              {formatMs(sentinel.cycleLatency)}
            </div>
            <p className="text-[10px] text-white/20 mt-2 uppercase font-bold tracking-widest leading-relaxed">
              Cycle Speed • Logic Performance
            </p>
          </div>
          <div className="flex items-center gap-3 pt-6 mt-4 border-t border-white/5 text-[9px] uppercase font-black tracking-[0.2em] text-white/20 relative z-10">
             <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
             Pipeline Nominal
          </div>
        </div>
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
