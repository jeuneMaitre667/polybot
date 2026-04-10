import React from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  Target, 
  Activity, 
  Clock,
  ArrowUpRight,
  ArrowDownRight
} from 'lucide-react';

export function LiveMarketView({ data }) {
  const mv = data?.dashboardMarketView;
  
  if (!mv) {
    return (
      <div className="bg-[#0a0b14]/80 backdrop-blur-3xl border border-white/5 rounded-3xl p-8 flex flex-col items-center justify-center min-h-[400px]">
        <div className="relative mb-6">
           <div className="absolute inset-0 bg-blue-500/20 blur-3xl animate-pulse" />
           <Activity className="text-blue-500/40 relative animate-bounce" size={48} />
        </div>
        <h3 className="text-xl font-black text-white/40 tracking-tighter uppercase mb-2">Syncing Hybrid Engine...</h3>
        <p className="text-sm text-white/20 font-medium tracking-tight">Monitoring Binance open for next 5m trigger...</p>
      </div>
    );
  }

  const isUp = mv.binanceDeltaPct > 0;
  const isTriggered = Math.abs(mv.binanceDeltaPct) >= 0.10;
  
  // v2025 Hybrid logic
  const upPrice = mv.bestBid ? `${Math.round(mv.bestBid * 100)}¢` : '—';
  const downPrice = mv.bestBid ? `${Math.max(0, 100 - Math.round(mv.bestBid * 100))}¢` : '—';

  return (
    <div className="relative group overflow-hidden bg-[#0d0e1a] border border-white/10 rounded-[2.5rem] p-1 shadow-2xl">
      {/* Background Gloss */}
      <div className={`absolute -top-24 -right-24 w-96 h-96 blur-[100px] rounded-full transition-all duration-1000 ${isTriggered ? 'bg-orange-500/20' : 'bg-blue-600/10'}`} />
      
      <div className="relative flex flex-col gap-6 p-6">
        {/* Header: Market Type & Spot */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
             <div className={`w-14 h-14 rounded-2xl flex items-center justify-center border shadow-inner transition-colors ${isTriggered ? 'bg-orange-500/10 border-orange-500/30' : 'bg-blue-500/10 border-blue-500/20'}`}>
                {isTriggered ? <Target size={28} className="text-orange-500" /> : <TrendingUp size={28} className="text-blue-500" />}
             </div>
             <div>
                <h2 className="text-2xl font-black text-white tracking-tighter">Sniper <span className="text-white/40">Binance</span></h2>
                <div className="flex items-center gap-2">
                   <div className={`w-2 h-2 rounded-full animate-pulse ${isTriggered ? 'bg-orange-500' : 'bg-blue-500'}`} />
                   <span className={`text-[10px] font-bold uppercase tracking-widest leading-none ${isTriggered ? 'text-orange-400' : 'text-blue-400/80'}`}>
                      {isTriggered ? 'Targeting Strike...' : 'Awaiting Signal'}
                   </span>
                </div>
             </div>
          </div>

          <div className="flex flex-col items-end">
             <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em]">Binance Spot</span>
                <div className={`px-2 py-0.5 rounded-full text-[9px] font-bold flex items-center gap-1 ${isUp ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
                   {isUp ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
                   {Math.abs(mv.binanceDeltaPct).toFixed(3)}%
                </div>
             </div>
             <div className="text-3xl font-mono font-black text-white tracking-tighter">
                ${Number(mv.binanceSpot).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
             </div>
          </div>
        </div>

        {/* The Polymarket Mirror: Dual Buttons */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className={`relative group/btn cursor-default bg-emerald-500/5 border rounded-3xl p-6 transition-all ${isUp && isTriggered ? 'bg-emerald-500/20 border-emerald-500/60 shadow-[0_0_40px_rgba(16,185,129,0.1)]' : 'border-emerald-500/10 opacity-40'}`}>
             <div className="relative flex flex-col gap-3">
                <div className="flex justify-between items-center">
                    <span className="text-xs font-black text-emerald-400 uppercase tracking-widest">Polymarket UP</span>
                    {isUp && isTriggered && <span className="text-[10px] font-black bg-emerald-500 text-black px-2 py-0.5 rounded animate-pulse">SNIPER PRÊT</span>}
                </div>
                <div className="text-5xl font-mono font-black text-emerald-500 tracking-tighter">
                   {upPrice}
                </div>
                <div className="flex items-center gap-2 text-[10px] font-bold text-emerald-500/40 uppercase">
                   <Target size={12} />
                   Target &gt; ${Number(mv.binanceStrike).toLocaleString()}
                </div>
             </div>
          </div>

          <div className={`relative group/btn cursor-default bg-rose-500/5 border rounded-3xl p-6 transition-all ${!isUp && isTriggered ? 'bg-rose-500/20 border-rose-500/60 shadow-[0_0_40px_rgba(244,63,94,0.1)]' : 'border-rose-500/10 opacity-40'}`}>
             <div className="relative flex flex-col gap-3">
                <div className="flex justify-between items-center">
                    <span className="text-xs font-black text-rose-400 uppercase tracking-widest">Polymarket DOWN</span>
                    {!isUp && isTriggered && <span className="text-[10px] font-black bg-rose-500 text-white px-2 py-0.5 rounded animate-pulse">SNIPER PRÊT</span>}
                </div>
                <div className="text-5xl font-mono font-black text-rose-500 tracking-tighter">
                   {downPrice}
                </div>
                <div className="flex items-center gap-2 text-[10px] font-bold text-rose-500/40 uppercase">
                   <Target size={12} />
                   Target &lt; ${Number(mv.binanceStrike).toLocaleString()}
                </div>
             </div>
          </div>
        </div>

        {/* Footer Stats Row */}
        <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-4 flex items-center justify-between">
           <div className="flex gap-8">
              <div className="flex flex-col gap-1">
                 <span className="text-[9px] font-black text-white/20 uppercase tracking-widest">Binance Strike (Open)</span>
                 <span className="text-sm font-mono font-bold text-white/60">${Number(mv.binanceStrike).toLocaleString()}</span>
              </div>
              <div className="flex flex-col gap-1">
                 <span className="text-[9px] font-black text-white/20 uppercase tracking-widest">Binance Delta</span>
                 <span className={`text-sm font-mono font-bold ${isUp ? 'text-emerald-500/80' : 'text-rose-500/80'}`}>
                    {mv.binanceDeltaPct > 0 ? '+' : ''}{mv.binanceDeltaPct.toFixed(3)}%
                 </span>
              </div>
           </div>
           
           <div className="flex flex-col items-end">
              <div className="text-xs font-mono font-black text-blue-400/60 uppercase tracking-tighter">
                 Strategy: Hybrid 0.10%
              </div>
              <div className="text-[10px] font-bold text-white/10 mt-1">
                 {mv.updatedAt ? new Date(mv.updatedAt).toLocaleTimeString() : '---'}
              </div>
           </div>
        </div>
      </div>
    </div>
  );
}
