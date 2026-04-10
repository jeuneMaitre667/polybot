import { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { DEFAULT_BOT_STATUS_URL, useBotStatus } from '@/hooks/useBotStatus.js';
import { DecisionFeed } from './DecisionFeed';
import { LatencySentinelCards } from './LatencySentinelCards';
import LatencyTimelineChart from './LatencyTimelineChart';
import { SniperLaunchpad } from './SniperLaunchpad';
import { SniperFilterAudit } from './SniperFilterAudit';
import { PnLAnalyticsCard } from './PnLAnalyticsCard';
import { LiveMarketView } from './LiveMarketView';

export function BotOverview() {
  const statusUrl = DEFAULT_BOT_STATUS_URL; // Sniper specific
  const { data, loading } = useBotStatus(statusUrl, 2000);
  
  // --- CLOCK & STALENESS ---
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const isStale = data?.timestamp 
    ? (currentTime - data.timestamp > 300_000) 
    : false;

  const hasData = !!data;
  const isSimulation = data?.simulation !== undefined ? data.simulation : (data?.lastOrder?.simulationTrade || data?.config?.isSimulation || false);

  return (
    <div className="space-y-12 p-4 md:p-8 animate-in fade-in duration-1000">
      
      {/* 1. TOP PERFORMANCE HUD */}
      <div className="flex flex-wrap items-center justify-between gap-6 p-8 rounded-[2.5rem] bg-white/[0.01] border border-white/5 backdrop-blur-3xl shadow-2xl relative overflow-hidden group">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
        <div className="flex items-center gap-10 relative z-10">
          <div className="space-y-1">
            <span className="text-[10px] text-white/20 uppercase font-black tracking-[0.2em]">Net Capital</span>
            <div className="text-3xl font-mono font-bold text-emerald-400 tracking-tighter">
               {data?.totalUsd || data?.balanceUsd ? `$${Number(data.totalUsd || data.balanceUsd).toLocaleString(undefined, {minimumFractionDigits:2})}` : '---'}
            </div>
          </div>
          <div className="h-12 w-[1px] bg-white/5" />
          <div className="space-y-1">
            <span className="text-[10px] text-white/20 uppercase font-black tracking-[0.2em]">Virtual Balance</span>
            <div className="text-xl font-mono font-bold text-white/60">
               {data?.balance ? `$${Number(data.balance).toLocaleString()}` : '---'}
            </div>
          </div>
          <div className="h-12 w-[1px] bg-white/5" />
          <div className="space-y-1">
            <span className="text-[10px] text-white/20 uppercase font-black tracking-[0.2em]">GAS LEVEL</span>
            <div className={`text-xl font-mono font-bold ${data?.gasBalance < 0.5 ? 'text-red-500 animate-pulse' : 'text-blue-400'}`}>
               {data?.gasBalance != null ? data.gasBalance : '---'} <span className="text-[10px] opacity-40">POL</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 px-5 py-2.5 rounded-2xl bg-white/[0.03] border border-white/10 relative z-10 transition-all hover:bg-white/[0.05]">
           <div className={`w-2 h-2 rounded-full ${(!hasData || isStale) ? 'bg-red-500 animate-ping shadow-[0_0_10px_rgba(239,68,68,0.5)]' : 'bg-blue-500 animate-pulse shadow-[0_0_15px_rgba(0,82,255,0.6)]'}`} />
           <span className="text-[10px] text-white/70 font-black uppercase tracking-widest">
             {loading ? 'Connecting...' : !hasData ? 'Node Offline' : isStale ? 'Data Stale' : 'Engine Live'}
           </span>
           <div className="h-3 w-[1px] bg-white/10" />
           <span className="text-[10px] text-white/30 font-mono">
             {data?.timestamp ? new Date(data.timestamp).toLocaleTimeString() : '---'}
           </span>
        </div>
      </div>

      {/* 2. SNIPER CORE (THE HERO SECTION) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <LiveMarketView data={data} />
          <SniperLaunchpad data={data} />
        </div>
        <div className="lg:col-span-1">
          <SniperFilterAudit data={data} />
        </div>
      </div>

      {/* 3. PERFORMANCE CHARTS */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
        {/* PnL Growth */}
        <div className="p-8 rounded-[2rem] bg-white/[0.01] border border-white/5 backdrop-blur-sm group hover:border-blue-500/20 transition-all relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/5 blur-[50px] -mr-16 -mt-16" />
          <div className="flex items-center justify-between mb-8 relative z-10">
            <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-white/20">Session PnL Velocity</h3>
            <div className="px-3 py-1 rounded-full bg-blue-500/10 text-blue-400 text-[10px] font-bold border border-blue-500/20">ALPHA GROWTH</div>
          </div>
          <div className="h-[200px] w-full relative z-10">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data?.equityHistory || []}>
                <defs>
                  <linearGradient id="colorEq" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0052FF" stopOpacity={0.4}/>
                    <stop offset="95%" stopColor="#0052FF" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <Tooltip 
                  contentStyle={{ backgroundColor: '#030712', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px', backdropFilter: 'blur(10px)' }}
                  labelStyle={{ color: 'rgba(255,255,255,0.4)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.1em' }}
                />
                <Area type="monotone" dataKey="v" stroke="#0052FF" fillOpacity={1} fill="url(#colorEq)" strokeWidth={4} />
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
              <div className="p-6 rounded-3xl bg-white/[0.02] border border-white/5 group hover:bg-white/[0.04] transition-colors">
                <span className="text-[9px] uppercase font-bold text-white/20 tracking-widest block mb-2">Sim Mode</span>
                <span className={`text-2xl font-mono font-bold ${isSimulation ? 'text-blue-500' : 'text-amber-500'}`}>
                  {isSimulation ? 'ACTIVE' : 'OFF'}
                </span>
              </div>
           </div>
        </div>
      </div>

      {/* 4. LATENCY & INFRASTRUCTURE */}
      <div className="space-y-8">
        <LatencySentinelCards data={data} />
        <div className="p-8 rounded-[2rem] bg-white/[0.01] border border-white/5 backdrop-blur-sm relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/5 blur-[50px] -mr-16 -mt-16" />
          <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-white/20 mb-8 relative z-10">Execution Latency (WS vs Poll)</h3>
          <div className="h-[240px] relative z-10">
            <LatencyTimelineChart data={data?.latencyHistory} />
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
