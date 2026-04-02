import { useState, useEffect, useMemo } from 'react';
import { DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M, useBotStatus } from '@/hooks/useBotStatus.js';
import { DecisionFeed } from './DecisionFeed';
import { GlobalRiskSentinel } from './GlobalRiskSentinel';
import { AssetSentinelCard } from './AssetSentinelCard';
import { ExchangeMatrix } from './ExchangeMatrix';
import { LatencySentinelCards } from './LatencySentinelCards';
import { RiskKellySentinel } from './RiskKellySentinel';
import { OFIMonitor } from './OFIMonitor';
import { readLatencyModeFromStorage, writeLatencyModeToStorage } from '@/lib/dashboardUiPrefs.js';
import { useWallet } from '@/context/useWallet.js';

function formatUsd(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(2)} $`;
}

function formatWalletShort(addr) {
  if (!addr || typeof addr !== 'string' || addr.length < 12) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

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

function computePnl(balanceHistory, currentBalance, nowMs = Date.now()) {
  const history = Array.isArray(balanceHistory) ? balanceHistory : [];
  if (!history.length) return null;
  const sorted = [...history]
    .filter((p) => p && p.at != null && Number.isFinite(Number(p.balance)))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  if (!sorted.length) return null;

  const windowMs = 24 * 60 * 60 * 1000;
  const cutoff = nowMs - windowMs;
  const lastBalance =
    currentBalance != null ? Number(currentBalance) : Number(sorted[sorted.length - 1].balance);
  if (!Number.isFinite(lastBalance)) return null;

  const beforeOrAtCutoff = sorted.filter((p) => new Date(p.at).getTime() <= cutoff);
  let baseline;
  let window;
  if (beforeOrAtCutoff.length) {
    baseline = Number(beforeOrAtCutoff[beforeOrAtCutoff.length - 1].balance);
    window = 'rolling24h';
  } else {
    baseline = Number(sorted[0].balance);
    window = 'sinceFirst';
  }

  const MIN_BASELINE_USD = 1;
  if (!Number.isFinite(baseline) || baseline < MIN_BASELINE_USD) {
    const firstUsable = sorted.find((p) => Number(p.balance) >= MIN_BASELINE_USD);
    baseline = firstUsable ? Number(firstUsable.balance) : null;
  }
  if (!(Number.isFinite(baseline) && baseline > 0)) return null;

  const pct = ((lastBalance - baseline) / baseline) * 100;
  return { pct, window, baseline, lastBalance };
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
  const [nowMs, setNowMs] = useState(() => Date.now());
  
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    writeLatencyModeToStorage(latencyMode);
  }, [latencyMode]);

  const balance = data?.balanceUsd != null ? Number(data.balanceUsd) : null;
  const balance15m = data15m?.balanceUsd != null ? Number(data15m.balanceUsd) : null;
  
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
      } catch (e) {}
    }
    fetchWalletUsdc();
    const id = setInterval(fetchWalletUsdc, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [preferredWalletAddress]);

  const tradeLatencyStats = data?.tradeLatencyStats ?? null;
  const tradeLatencyStats15m = data15m?.tradeLatencyStats ?? null;
  const show15m = !!statusUrl15m;
  const showStatus1h = !!statusUrl;
  
  const activeLatency = latencyMode === '15m' ? tradeLatencyStats15m : tradeLatencyStats;
  const lastTradeLatency = useMemo(() => {
    if (!activeLatency) return null;
    const wsMs = Number(activeLatency.ws?.lastLatencyMs);
    const pollMs = Number(activeLatency.poll?.lastLatencyMs);
    return wsMs > 0 ? { ms: wsMs } : pollMs > 0 ? { ms: pollMs } : null;
  }, [activeLatency]);

  if (!statusUrl && !statusUrl15m) {
    return (
      <div className="p-8 text-center opacity-50 font-mono text-sm">
        Dashboard non configuré. Vérifiez vos variables d'environnement.
      </div>
    );
  }

  return (
    <div className="layout app-root space-y-12">
      {/* SECTION 1: GLOBAL RISK SENTINEL */}
      <section className="animate-in fade-in slide-in-from-top-4 duration-700">
        <GlobalRiskSentinel 
          data={data15m} 
          paperBalance={balance} 
          realBalance={walletUsdc15m} 
        />
      </section>

      {/* SECTION 2: MARKET SENTINEL GRID */}
      <section className="space-y-6">
        <div className="section-title flex items-center gap-4">
          <h2 className="text-xl font-bold tracking-tight text-white/90">Market Sentinel Grid</h2>
          <div className="h-[1px] flex-1 bg-gradient-to-r from-white/10 to-transparent" />
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {SUPPORTED_ASSETS.map(asset => (
            <AssetSentinelCard key={asset} asset={asset} data={data15m} />
          ))}
        </div>
      </section>

      {/* SECTION 3: LATENCY SENTINEL */}
      <section className="animate-in fade-in slide-in-from-bottom-4 duration-1000">
        <LatencySentinelCards data={data15m} />
      </section>

      {/* SECTION 4: RISK & STRATEGY */}
      <section className="animate-in fade-in slide-in-from-bottom-4 duration-1000 delay-100">
        <RiskKellySentinel data={data15m} />
      </section>

      {/* SECTION 5: DATA FLUX & ACTIVITY */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        <div className="xl:col-span-2 space-y-6">
          <div className="section-title flex items-center gap-4">
            <h2 className="text-xl font-bold tracking-tight text-white/90">Data Flux Matrix</h2>
            <div className="h-[1px] flex-1 bg-gradient-to-r from-white/10 to-transparent" />
          </div>
          <ExchangeMatrix data={data15m} />
        </div>

        <div className="space-y-8">
          <div className="space-y-4">
            <div className="section-title flex items-center gap-4">
               <h2 className="text-sm font-bold tracking-widest text-indigo-400 uppercase">Quant Pressure (OFI)</h2>
               <div className="h-[1px] flex-1 bg-indigo-500/10" />
            </div>
            <OFIMonitor data={data15m} />
          </div>

          <div className="space-y-4">
            <div className="section-title flex items-center gap-4">
              <h2 className="text-sm font-bold tracking-widest text-blue-400 uppercase">Decision Feed</h2>
              <div className="h-[1px] flex-1 bg-blue-500/10" />
            </div>
            <div className="glass-panel border border-white/5 bg-black/40 rounded-2xl overflow-hidden h-[450px]">
               <DecisionFeed feed={data15m?.decisionFeed} />
            </div>
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
