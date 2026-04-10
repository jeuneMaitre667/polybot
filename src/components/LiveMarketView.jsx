import React, { useMemo } from 'react';
import { 
  Target, 
  Activity, 
  Clock,
  ArrowUpRight,
  ArrowDownRight,
  ShieldCheck,
  Zap,
  Info
} from 'lucide-react';

export function LiveMarketView({ data }) {
  const mv = data?.dashboardMarketView;
  const sniper = data?.sniperHUD?.btc;
  const decisionLog = data?.decisionFeed?.slice(-3).reverse();

  // v14.12: High-Precision Formatting
  const isUp = mv?.binanceDeltaPct > 0;
  const deltaAbs = mv ? (mv.binanceSpot - mv.binanceStrike) : 0;
  const isTriggered = Math.abs(mv?.binanceDeltaPct || 0) >= 0.10;
  const secondsLeft = sniper?.secondsLeft || 0;
  const progressPct = Math.min(100, Math.max(0, (300 - secondsLeft) / 300 * 100));

  if (!mv) {
    return (
      <div className="bg-[#0a0b14]/80 backdrop-blur-3xl border border-white/5 rounded-3xl p-8 flex flex-col items-center justify-center min-h-[400px]">
        <div className="relative mb-6">
           <div className="absolute inset-0 bg-blue-500/20 blur-3xl animate-pulse" />
           <Activity className="text-blue-500/40 relative animate-bounce" size={48} />
        </div>
        <h3 className="text-xl font-black text-white/40 tracking-tighter uppercase mb-2">Syncing Hybrid Engine...</h3>
        <p className="text-sm text-white/20 font-medium tracking-tight">Monitoring Binance USDC for next 5m trigger...</p>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col gap-6">
      {/* --- TOP STATUS BAR --- */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isTriggered ? 'bg-orange-500/20 text-orange-400' : 'bg-blue-500/20 text-blue-400'}`}>
              <Zap size={20} />
            </div>
            <div>
              <div className="text-[9px] font-black text-white/20 uppercase tracking-[0.2em]">Strategy Mode</div>
              <div className="text-xs font-bold text-white/80">Hybrid Sniper 0.10%</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[9px] font-black text-white/20 uppercase tracking-[0.2em]">Status</div>
            <div className={`text-xs font-black uppercase ${isTriggered ? 'text-orange-500' : 'text-blue-400 opacity-60'}`}>
              {isTriggered ? 'Trigger Active' : 'Hunting...'}
            </div>
          </div>
        </div>

        <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-4 flex items-center justify-between col-span-1 md:col-span-2">
           <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-purple-500/20 text-purple-400 flex items-center justify-center">
                <Clock size={20} />
              </div>
              <div className="flex-1">
                 <div className="flex justify-between items-center mb-1">
                   <span className="text-[9px] font-black text-white/20 uppercase tracking-[0.2em]">Next Slot Closure</span>
                   <span className="text-xs font-mono font-bold text-white/60">{Math.floor(secondsLeft / 60)}m {secondsLeft % 60}s</span>
                 </div>
                 <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-1000" 
                      style={{ width: `${progressPct}%` }}
                    />
                 </div>
              </div>
           </div>
        </div>
      </div>

      {/* --- CORE TRADING CARD --- */}
      <div className="relative group overflow-hidden bg-[#0d0e1a] border border-white/10 rounded-[2.5rem] p-1 shadow-2xl">
        <div className={`absolute -top-24 -right-24 w-96 h-96 blur-[100px] rounded-full transition-all duration-1000 ${isUp ? 'bg-emerald-500/10' : 'bg-rose-500/10'}`} />
        
        <div className="relative flex flex-col gap-8 p-8">
          {/* Binance Context Section */}
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-white/5 pb-8">
            <div className="flex items-center gap-5">
               <div className="w-16 h-16 rounded-3xl bg-white/[0.03] border border-white/10 flex items-center justify-center shadow-2xl">
                  <Activity size={32} className="text-white/40" />
               </div>
               <div>
                  <h2 className="text-3xl font-black text-white tracking-tighter">BTC <span className="text-white/20">/ USDC</span></h2>
                  <div className="flex items-center gap-2 mt-1">
                     <div className={`px-2 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${isUp ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
                        {isUp ? '📈 Bullish Momentum' : '📉 Bearish Pressure'}
                     </div>
                  </div>
               </div>
            </div>

            <div className="flex items-end gap-10">
               <div className="flex flex-col items-end">
                  <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em] mb-1">Variation (Delta %)</span>
                  <div className={`text-4xl font-mono font-black tracking-tighter ${isUp ? 'text-emerald-500' : 'text-rose-500'}`}>
                     {isUp ? '+' : ''}{mv.binanceDeltaPct.toFixed(3)}%
                  </div>
               </div>
               <div className="flex flex-col items-end">
                  <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em] mb-1">Live Delta ($)</span>
                  <div className="text-2xl font-mono font-bold text-white tracking-tighter">
                     {deltaAbs > 0 ? '+' : ''}${Math.abs(deltaAbs).toFixed(2)}
                  </div>
               </div>
            </div>
          </div>

          {/* Pricing Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white/[0.02] border border-white/10 rounded-3xl p-6">
               <div className="flex justify-between items-center mb-4">
                  <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em]">Binance Reference</span>
                  <ShieldCheck size={14} className="text-blue-500/40" />
               </div>
               <div className="space-y-4">
                  <div className="flex justify-between items-center">
                     <span className="text-sm font-medium text-white/40">Market Spot</span>
                     <span className="text-xl font-mono font-bold text-white">${Number(mv.binanceSpot).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between items-center">
                     <span className="text-sm font-medium text-white/40">Opening Strike</span>
                     <span className="text-xl font-mono font-bold text-white/80">${Number(mv.binanceStrike).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
               </div>
            </div>

            <div className="bg-white/[0.02] border border-white/10 rounded-3xl p-6">
               <div className="flex justify-between items-center mb-4">
                  <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em]">Polymarket Execution</span>
                  <Target size={14} className="text-emerald-500/40" />
               </div>
               <div className="space-y-4">
                  <div className="flex justify-between items-center">
                     <span className="text-sm font-medium text-white/40">Best Ask (Trigger)</span>
                     <span className="text-xl font-mono font-bold text-emerald-500">{mv.bestAsk ? `${(mv.bestAsk * 100).toFixed(1)}¢` : '—'}</span>
                  </div>
                  <div className="flex justify-between items-center">
                     <span className="text-sm font-medium text-white/40">Best Bid (Maker)</span>
                     <span className="text-xl font-mono font-bold text-white/80">{mv.bestBid ? `${(mv.bestBid * 100).toFixed(1)}¢` : '—'}</span>
                  </div>
               </div>
            </div>
          </div>

          {/* Decision Timeline Strip */}
          <div className="bg-black/40 rounded-2xl p-4 flex flex-col gap-2">
             <div className="flex items-center gap-2 mb-2">
                <Info size={12} className="text-blue-400" />
                <span className="text-[10px] font-black text-white/20 uppercase tracking-[0.2em]">Live Decision Feed</span>
             </div>
             <div className="flex flex-col gap-1.5">
                {decisionLog && decisionLog.length > 0 ? decisionLog.map((log, i) => (
                  <div key={i} className="flex items-center justify-between text-[10px] font-medium py-1 border-b border-white/5 last:border-0">
                    <span className={`uppercase tracking-widest ${log.decision === 'TRADE' ? 'text-orange-500' : 'text-white/30'}`}>{log.decision}</span>
                    <span className="text-white/60 truncate max-w-[70%]">{log.reason}</span>
                    <span className="text-white/20 font-mono">{new Date(log.at).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                  </div>
                )) : (
                  <div className="text-[10px] text-white/10 italic">Awaiting pulse...</div>
                )}
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}
