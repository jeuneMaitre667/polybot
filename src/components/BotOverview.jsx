import { useState, useEffect, useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { DEFAULT_BOT_STATUS_URL_15M, useBotStatus } from '@/hooks/useBotStatus.js';
import { DecisionFeed } from './DecisionFeed';
import { LatencySentinelCards } from './LatencySentinelCards';
import LatencyTimelineChart from './LatencyTimelineChart';
import { SniperLaunchpad } from './SniperLaunchpad';
import { SniperFilterAudit } from './SniperFilterAudit';
import { PnLAnalyticsCard } from './PnLAnalyticsCard';

export function BotOverview() {
  const statusUrl = DEFAULT_BOT_STATUS_URL_15M; // Sniper specific
  const { data } = useBotStatus(statusUrl, 2000);
  
  // --- CLOCK & STALENESS ---
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const isStale = data?.timestamp 
    ? (currentTime - data.timestamp > 300_000) 
    : false;

  return (
    <div className="space-y-12 p-4 md:p-8 animate-in fade-in duration-1000">
      
      {/* 1. TOP PERFORMANCE HUD */}
      <div className="flex flex-wrap items-center justify-between gap-6 p-6 rounded-[2rem] bg-white/[0.02] border border-white/5 backdrop-blur-3xl">
        <div className="flex items-center gap-8">
          <div className="space-y-1">
            <span className="text-[10px] text-white/30 uppercase font-black tracking-[0.2em]">Net Capital</span>
            <div className="text-2xl font-mono font-bold text-emerald-400">
               {data?.totalUsd ? `$${Number(data.totalUsd).toLocaleString(undefined, {minimumFractionDigits:2})}` : '---'}
            </div>
          </div>
          <div className="h-10 w-[1px] bg-white/5" />
          <div className="space-y-1">
            <span className="text-[10px] text-white/30 uppercase font-black tracking-[0.2em]">Virtual Balance</span>
            <div className="text-xl font-mono font-bold text-white/70">
               {data?.balance ? `$${Number(data.balance).toLocaleString()}` : '---'}
            </div>
          </div>
          <div className="h-10 w-[1px] bg-white/5" />
          <div className="space-y-1">
            <span className="text-[10px] text-white/30 uppercase font-black tracking-[0.2em]">GAS LEVEL</span>
            <div className={`text-xl font-mono font-bold ${data?.gasBalance < 0.5 ? 'text-red-500 animate-pulse' : 'text-amber-400'}`}>
               {data?.gasBalance || '---'} <span className="text-[10px] opacity-40">POL</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 px-4 py-2 rounded-2xl bg-white/[0.03] border border-white/5">
           <div className={`w-2 h-2 rounded-full ${isStale ? 'bg-red-500 animate-ping' : 'bg-emerald-500 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.5)]'}`} />
           <span className="text-[10px] text-white/60 font-black uppercase tracking-widest">
             {isStale ? 'System Stall' : 'Engine Live'}
           </span>
           <span className="text-[10px] text-white/20 font-mono">
             {data?.timestamp ? new Date(data.timestamp).toLocaleTimeString() : '---'}
           </span>
        </div>
      </div>

      {/* 2. SNIPER CORE (THE HERO SECTION) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          <SniperLaunchpad data={data} />
        </div>
        <div className="lg:col-span-1">
          <SniperFilterAudit data={data} />
        </div>
      </div>

      {/* 3. PERFORMANCE CHARTS */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
        {/* PnL Growth */}
        <div className="p-8 rounded-[2rem] bg-white/[0.01] border border-white/5 backdrop-blur-sm group hover:border-indigo-500/20 transition-all">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-white/20">Session PnL Velocity</h3>
            <div className="px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 text-[10px] font-bold">ALPHA GROWTH</div>
          </div>
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data?.equityHistory || []}>
                <defs>
                  <linearGradient id="colorEq" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <Tooltip 
                  contentStyle={{ backgroundColor: '#000', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                  labelStyle={{ color: 'rgba(255,255,255,0.4)', fontSize: '10px' }}
                />
                <Area type="monotone" dataKey="v" stroke="#6366f1" fillOpacity={1} fill="url(#colorEq)" strokeWidth={3} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Trade Statistics */}
        <div className="flex flex-col gap-8">
           <PnLAnalyticsCard performance={data?.performance} />
           <div className="grid grid-cols-2 gap-4">
              <div className="p-6 rounded-3xl bg-white/[0.02] border border-white/5">
                <span className="text-[9px] uppercase font-bold text-white/20 tracking-widest block mb-2">Open Trades</span>
                <span className="text-2xl font-mono font-bold text-white/80">{data?.openLimitOrders || 0}</span>
              </div>
              <div className="p-6 rounded-3xl bg-white/[0.02] border border-white/5">
                <span className="text-[9px] uppercase font-bold text-white/20 tracking-widest block mb-2">Sim Mode</span>
                <span className="text-2xl font-mono font-bold text-indigo-400">{data?.simulation ? 'ACTIVE' : 'OFF'}</span>
              </div>
           </div>
        </div>
      </div>

      {/* 4. LATENCY & INFRASTRUCTURE */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        <div className="lg:col-span-1">
          <LatencySentinelCards data={data} />
        </div>
        <div className="lg:col-span-3">
          <div className="p-6 rounded-3xl bg-white/[0.01] border border-white/5 h-full">
            <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-white/20 mb-6">Execution Latency (WS vs Poll)</h3>
            <div className="h-[180px]">
              <LatencyTimelineChart data={data?.latencyHistory} />
            </div>
          </div>
        </div>
      </div>

      {/* 5. DECISION STREAM */}
      <div className="space-y-6">
        <div className="flex items-center gap-4">
            <h2 className="text-xl font-black uppercase tracking-tighter text-white/90">Signal Stream</h2>
            <div className="h-[1px] flex-1 bg-gradient-to-r from-white/10 to-transparent" />
        </div>
        <div className="glass-panel border border-white/5 bg-black/40 rounded-[2rem] overflow-hidden h-[500px]">
            <DecisionFeed feed={data?.decisionFeed} />
        </div>
      </div>

    </div>
  );
}
