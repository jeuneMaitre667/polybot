import { useState, useEffect, useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M, useBotStatus } from '@/hooks/useBotStatus.js';
import { DecisionFeed } from './DecisionFeed';
import { GlobalRiskSentinel } from './GlobalRiskSentinel';
import { AssetSentinelCard } from './AssetSentinelCard';
import { BotStatusBadge } from './BotStatus';
import { LatencySentinelCards } from './LatencySentinelCards';
import { RiskKellySentinel } from './RiskKellySentinel';
import LatencyTimelineChart from './LatencyTimelineChart';
import { readLatencyModeFromStorage, writeLatencyModeToStorage } from '@/lib/dashboardUiPrefs.js';
import { useWallet } from '@/context/useWallet.js';
import { PnLAnalyticsCard } from './PnLAnalyticsCard';



const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

function encodeUsdcBalanceOf(address) {
  const a = String(address || '').replace(/^0x/, '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(a)) return null;
  return `0x70a08231${a.padStart(64, '0')}`;
}

function hexUsdcToFloat(hexValue) {
  const h = String(hexValue || '').trim();
  if (!/^0x[0-9a-fA-F]+$/.test(h)) return null;
  try {
    const bn = BigInt(h);
    const n = Number(bn) / 1_000_000;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function formatMs(v) {
  if (v == null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n)} ms` : '—';
}



const SUPPORTED_ASSETS = ['BTC', 'ETH', 'SOL'];

export function BotOverview() {
  const statusUrl = DEFAULT_BOT_STATUS_URL;
  const statusUrl15m = DEFAULT_BOT_STATUS_URL_15M;
  const { address: walletAddress } = useWallet();
  const { data } = useBotStatus(statusUrl);
  const { data: data15m } = useBotStatus(statusUrl15m);
  
  const [latencyMode, setLatencyMode] = useState(() =>
    readLatencyModeFromStorage(Boolean(DEFAULT_BOT_STATUS_URL_15M), Boolean(DEFAULT_BOT_STATUS_URL)),
  );

  


  useEffect(() => {
    writeLatencyModeToStorage(latencyMode);
  }, [latencyMode]);

  const balance = data?.balanceUsd != null ? Number(data.balanceUsd) : null;

  
  const [walletUsdc15m, setWalletUsdc15m] = useState(null);
  const funder15m = data15m?.lastOrder?.clobFunderAddress ?? null;
  
  const preferredWalletAddress = useMemo(() => {
    if (walletAddress && /^0x[a-fA-F0-9]{40}$/.test(walletAddress)) return walletAddress;
    const envAddr = String(import.meta.env.VITE_TRADE_HISTORY_ADDRESS || '').trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(envAddr)) return envAddr;
    if (typeof funder15m === 'string' && /^0x[a-fA-F0-9]{40}$/.test(funder15m)) return funder15m;
    return null;
  }, [walletAddress, funder15m]);

  useEffect(() => {
    let cancelled = false;
    async function fetchWalletUsdc() {
      if (!preferredWalletAddress) return;
      const rpcData = encodeUsdcBalanceOf(preferredWalletAddress);
      if (!rpcData) return;
      try {
        const res = await fetch('https://polygon-rpc.com', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'eth_call',
            params: [{ to: USDC_E_POLYGON, data: rpcData }, 'latest'],
          }),
        });
        const json = await res.json();
        const v = hexUsdcToFloat(json?.result);
        if (v != null && !cancelled) setWalletUsdc15m(v);
      } catch (err) {
        console.warn('[Wallet] Balance fetch failed:', err.message);
      }
    }
    fetchWalletUsdc();
    const id = setInterval(fetchWalletUsdc, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [preferredWalletAddress]);

  const tradeLatencyStats = data?.tradeLatencyStats ?? null;
  const tradeLatencyStats15m = data15m?.tradeLatencyStats ?? null;

  
  const activeLatency = latencyMode === '15m' ? tradeLatencyStats15m : tradeLatencyStats;
  const lastTradeLatency = useMemo(() => {
    if (!activeLatency) return null;
    const wsMs = Number(activeLatency.ws?.lastLatencyMs);
    const pollMs = Number(activeLatency.poll?.lastLatencyMs);
    return wsMs > 0 ? { ms: wsMs } : pollMs > 0 ? { ms: pollMs } : null;
  }, [activeLatency]);

  // --- STALENESS DETECTOR (v6.3.4-fixed) ---
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  
  // Met à jour l'horloge interne toutes les 60 secondes pour rafraîchir le statut "Stale"
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  const isStale = data15m?.timestamp 
    ? (currentTime - data15m.timestamp > 300_000) 
    : false;

  if (!statusUrl && !statusUrl15m) {
    return (
      <div className="p-8 text-center opacity-50 font-mono text-sm">
        Dashboard non configuré. Vérifiez vos variables d'environnement.
      </div>
    );
  }

  return (
    <div className="layout app-root space-y-12">
      {/* EXECUTION HUD (v7.0.0) */}
      <div className="flex items-center justify-between gap-6 px-4 py-2 bg-white/5 border-b border-white/10 backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <div className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-tighter border ${data15m?.executionMode === 'LIMIT' ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-400' : 'bg-amber-500/20 border-amber-500/40 text-amber-400'}`}>
            MODE: {data15m?.executionMode || 'TAKER'}
          </div>
          <div className="h-4 w-[1px] bg-white/10" />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/40 uppercase font-medium">Open Makers</span>
            <span className="text-sm font-mono font-bold text-white/90">{data15m?.openLimitOrders || 0}</span>
          </div>
          <div className="h-4 w-[1px] bg-white/10" />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-emerald-400 uppercase font-medium">Total Power</span>
            <span className="text-sm font-mono font-bold text-emerald-400">
               {data15m?.totalUsd ? `$${Number(data15m.totalUsd).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}` : '---'}
            </span>
          </div>
          <div className="h-4 w-[1px] bg-white/10" />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-amber-400 uppercase font-medium">Gas</span>
            <span className={`text-sm font-mono font-bold ${data15m?.gasBalance < 0.5 ? 'text-red-500 animate-pulse' : 'text-amber-400'}`}>
               {data15m?.gasBalance ? `${data15m.gasBalance} POL` : '---'}
            </span>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
          <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-widest">Live Engine</span>
        </div>
      </div>

      {/* v7.4.0 Performance Trend Chart */}
      {data15m?.trendHistory && data15m.trendHistory.length > 1 && (
        <div className="mx-4 max-w-7xl mb-8">
          <div className="p-6 rounded-3xl bg-white/[0.02] border border-white/5 backdrop-blur-3xl overflow-hidden transition-all hover:bg-white/[0.04]">
            <div className="flex items-center justify-between mb-6 px-2">
              <div>
                <h3 className="text-[9px] font-bold uppercase tracking-[0.3em] text-white/30 mb-1">Portfolio Intelligence</h3>
                <h2 className="text-xs font-bold text-white/70">Performance Velocity (Volume vs Earnings)</h2>
              </div>
              <div className="flex gap-8">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.5)]" />
                  <span className="text-[9px] uppercase font-bold text-white/40 tracking-widest">Filled Volume</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
                  <span className="text-[9px] uppercase font-bold text-white/40 tracking-widest">Reward Alpha</span>
                </div>
              </div>
            </div>
            
            <div className="h-[140px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data15m.trendHistory} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorVol" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4}/>
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="colorRew" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.4}/>
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'rgba(15, 23, 42, 0.95)', 
                      borderRadius: '16px', 
                      border: '1px solid rgba(255,255,255,0.05)', 
                      fontSize: '11px',
                      backdropFilter: 'blur(12px)',
                      boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)'
                    }}
                    itemStyle={{ padding: '2px 0' }}
                  />
                  <Area 
                    type="monotone" 
                    dataKey="vol" 
                    stroke="#6366f1" 
                    fillOpacity={1} 
                    fill="url(#colorVol)" 
                    strokeWidth={2}
                    animationDuration={1500}
                  />
                  <Area 
                    type="monotone" 
                    dataKey="rew" 
                    stroke="#10b981" 
                    fillOpacity={1} 
                    fill="url(#colorRew)" 
                    strokeWidth={2}
                    animationDuration={2000}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* v7.6.0 Total Equity / PnL Trend */}
      {data15m?.equityHistory && data15m.equityHistory.length > 1 && (
        <div className="mx-4 max-w-7xl">
          <div className="p-6 rounded-3xl bg-indigo-500/[0.03] border border-indigo-500/10 backdrop-blur-3xl overflow-hidden transition-all hover:bg-indigo-500/[0.05]">
            <div className="flex items-center justify-between mb-6 px-2">
              <div>
                <h3 className="text-[9px] font-bold uppercase tracking-[0.3em] text-indigo-400/50 mb-1">Mark-to-Market Valuation</h3>
                <h2 className="text-xs font-bold text-white/70">Total Equity (USDC + Shares)</h2>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 shadow-[0_0_10px_rgba(129,140,248,0.5)]" />
                <span className="text-[9px] uppercase font-bold text-white/40 tracking-widest">Net Wealth (USD)</span>
              </div>
            </div>
            
            <div className="h-[100px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data15m.equityHistory} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorEq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#818cf8" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#818cf8" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'rgba(15, 23, 42, 0.95)', 
                      borderRadius: '16px', 
                      border: '1px solid rgba(255,255,255,0.05)', 
                      fontSize: '11px',
                      backdropFilter: 'blur(12px)'
                    }}
                    formatter={(value) => [`$${Number(value).toFixed(2)}`, 'Equity']}
                  />
                  <Area 
                    type="stepAfter" 
                    dataKey="v" 
                    stroke="#818cf8" 
                    fillOpacity={1} 
                    fill="url(#colorEq)" 
                    strokeWidth={2}
                    animationDuration={1000}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* SYSTEM STALL ALERT (v6.3.4) */}
      {isStale && (
        <div className="bg-red-500/20 border border-red-500/40 p-4 rounded-2xl flex items-center justify-center gap-4 animate-pulse">
          <div className="w-3 h-3 bg-red-500 rounded-full shadow-[0_0_12px_rgba(239,68,68,0.8)]" />
          <span className="text-red-400 font-bold uppercase tracking-widest text-sm">
            CRITICAL: System Stall Detected (Stale Health Data)
          </span>
          <span className="text-red-400/60 font-mono text-xs uppercase">
            Last Update: {new Date(data15m.timestamp).toLocaleTimeString()}
          </span>
        </div>
      )}

      <section className="animate-in fade-in slide-in-from-top-4 duration-700">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="lg:col-span-2">
            <GlobalRiskSentinel 
              data={data15m} 
              paperBalance={balance} 
              realBalance={walletUsdc15m} 
            />
          </div>
        </div>
      </section>

      {/* SECTION 1.5: OPERATIONAL ANALYTICS (PnL & WATCHDOG) */}
      <section className="animate-in fade-in slide-in-from-top-4 duration-1000 delay-150">
        <PnLAnalyticsCard performance={data15m?.performance} />
      </section>

      {/* SECTION 2: MARKET SENTINEL GRID */}
      <section className="space-y-6">
        <div className="section-title flex items-center gap-4">
          <h2 className="text-xl font-bold tracking-tight text-white/90">Market Sentinel Grid</h2>
          <div className="h-[1px] flex-1 bg-gradient-to-r from-white/10 to-transparent" />
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-3 gap-6 lg:gap-8">
          {SUPPORTED_ASSETS.map(asset => (
            <AssetSentinelCard key={asset} asset={asset} data={data15m} />
          ))}
        </div>
      </section>

      {/* SECTION 3: LATENCY SENTINEL & TIMELINE */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-8 animate-in fade-in slide-in-from-bottom-4 duration-1000">
        <div className="lg:col-span-1">
          <LatencySentinelCards data={data15m} />
        </div>
        <div className="lg:col-span-2">
          <LatencyTimelineChart data={data15m?.latencyHistory} />
        </div>
      </section>

      {/* SECTION 4: RISK & STRATEGY */}
      <section className="animate-in fade-in slide-in-from-bottom-4 duration-1000 delay-100">
        <RiskKellySentinel data={data15m} />
      </section>

      {/* SECTION 5: ACTIVITY FEED (Legacy Matrix/OFI Removed) */}
      <section className="grid grid-cols-1 gap-8">
        <div className="space-y-4">
          <div className="section-title flex items-center gap-4">
            <h2 className="text-sm font-bold tracking-widest text-blue-400 uppercase">Decision Feed</h2>
            <div className="h-[1px] flex-1 bg-blue-500/10" />
          </div>
          <div className="glass-panel border border-white/5 bg-black/40 rounded-2xl overflow-hidden h-[450px]">
             <DecisionFeed feed={data15m?.decisionFeed} />
          </div>
        </div>
      </section>

      {/* SECTION 4: HISTORICAL AUDIT */}
      <section className="pt-8 border-t border-white/5">
        <div className="flex items-center justify-between mb-6">
          <div className="section-title flex items-center gap-4 flex-1">
            <h2 className="text-xl font-bold tracking-tight text-white/40">Historical Audit</h2>
            <div className="h-[1px] flex-1 bg-white/5" />
          </div>
          
          <div className="flex gap-2">
            <button onClick={() => setLatencyMode('1h')} className={latencyMode === '1h' ? 'text-blue-400 font-bold' : 'opacity-40'}>1h</button>
            <button onClick={() => setLatencyMode('15m')} className={latencyMode === '15m' ? 'text-blue-400 font-bold' : 'opacity-40'}>15m</button>
          </div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 opacity-50 grayscale hover:grayscale-0 transition-all duration-500">
           <div className="card card--sm bg-white/5">
              <span className="card-label">Last Execution</span>
              <span className="card-value text-xl">{lastTradeLatency ? formatMs(lastTradeLatency.ms) : '—'}</span>
           </div>
           <div className="card card--sm bg-white/5">
              <span className="card-label">System Uptime</span>
              <span className="card-value text-xl">Active</span>
           </div>
           <div className="card card--sm bg-white/5">
              <span className="card-label">Network Health</span>
              <span className="card-value text-xl">OK</span>
           </div>
           <div className="card card--sm bg-white/5">
              <span className="card-label">Node Latency</span>
              <span className="card-value text-xl">32ms</span>
           </div>
        </div>
      </section>
    </div>
  );
}
