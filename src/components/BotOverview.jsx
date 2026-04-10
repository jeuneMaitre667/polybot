import { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { DEFAULT_BOT_STATUS_URL, useBotStatus } from '@/hooks/useBotStatus.js';
import { DecisionFeed } from './DecisionFeed';
import { LatencySentinelCards } from './LatencySentinelCards';
import LatencyTimelineChart from './LatencyTimelineChart';
import { PnLAnalyticsCard } from './PnLAnalyticsCard';
import { LiveMarketView } from './LiveMarketView';
import { BinanceChartCard } from './BinanceChartCard';

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
    <div className="space-y-10 p-4 md:p-8 animate-in fade-in duration-1000 max-w-[1600px] mx-auto">
      
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
            <span className="text-[10px] text-white/20 uppercase font-black tracking-[0.2em]">Live Status</span>
            <div className="text-xl font-mono font-bold text-white/60">
               {data?.dashboardMarketView?.asset ? `${data.dashboardMarketView.asset}/USDC` : 'Scanning...'}
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

      {/* 2. HYBRID SNIPER COMMAND (Split Chart / Metrics) */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-8">
        <div className="xl:col-span-3">
          <BinanceChartCard />
        </div>
        <div className="xl:col-span-2">
          <LiveMarketView data={data} />
        </div>
      </div>

      {/* 3. PERFORMANCE CHARTS & STATS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="md:col-span-2 p-8 rounded-[2rem] bg-white/[0.01] border border-white/5 group hover:border-blue-500/20 transition-all">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-white/20">Session PnL Velocity</h3>
          </div>
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data?.equityHistory || []}>
                <defs>
                  <linearGradient id="colorEq" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0052FF" stopOpacity={0.4}/>
                    <stop offset="95%" stopColor="#0052FF" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="v" stroke="#0052FF" fillOpacity={1} fill="url(#colorEq)" strokeWidth={4} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="md:col-span-1 space-y-8">
           <PnLAnalyticsCard performance={data?.performance} />
           <div className="grid grid-cols-2 gap-4">
              <div className="p-6 rounded-3xl bg-white/[0.02] border border-white/5 group hover:bg-white/[0.04] transition-colors">
                <span className="text-[9px] uppercase font-bold text-white/20 tracking-widest block mb-1">Sim Mode</span>
                <span className={`text-xl font-mono font-bold ${isSimulation ? 'text-blue-500' : 'text-amber-500'}`}>
                  {isSimulation ? 'ACTIVE' : 'OFF'}
                </span>
              </div>
              <div className="p-6 rounded-3xl bg-white/[0.02] border border-white/5 opacity-50">
                <span className="text-[9px] uppercase font-bold text-white/20 tracking-widest block mb-1">Precision</span>
                <span className="text-xl font-mono font-bold text-white">99.8%</span>
              </div>
           </div>
        </div>
      </div>

      {/* 4. LATENCY & DECISION STREAM */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <LatencySentinelCards data={data} />
        <div className="glass-panel border border-white/5 bg-black/40 rounded-[2rem] overflow-hidden h-full max-h-[500px]">
           <DecisionFeed feed={data?.decisionFeed} />
        </div>
      </div>
    </div>
  );
}
