import React from 'react';
import { 
  Target, 
  Activity, 
  Clock,
  ArrowUpRight,
  ArrowDownRight,
  ShieldCheck,
  Zap,
  Info,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  TrendingUp,
  TrendingDown
} from 'lucide-react';

export function LiveMarketView({ data }) {
  const mv = data?.dashboardMarketView;
  const sniper = data?.sniperHUD?.btc;
  const decisionLog = data?.decisionFeed?.slice(-3).reverse();

  // v16.1: Precision Logic
  const isUp = mv?.binanceDeltaPct > 0;
  const deltaAbs = mv ? (mv.binanceSpot - mv.binanceStrike) : 0;
  const isTriggered = Math.abs(mv?.binanceDeltaPct || 0) >= 0.10;
  
  // Server-synced secondsLeft (0-300 range for 5m candle)
  const secondsLeft = sniper?.secondsLeft || 0;
  const isWindowOpen = secondsLeft >= 15 && secondsLeft <= 70; 
  const isAuthorized = isWindowOpen && mv?.binanceStrike > 0;
  
  if (!mv) {
    return (
      <div className="bg-[#0a0b14]/80 backdrop-blur-3xl border border-white/5 rounded-3xl p-8 flex flex-col items-center justify-center min-h-[400px]">
        <div className="relative mb-6">
           <div className="absolute inset-0 bg-blue-500/20 blur-3xl animate-pulse" />
           <Activity className="text-blue-500/40 relative animate-bounce" size={48} />
        </div>
        <h3 className="text-xl font-black text-white/40 tracking-tighter uppercase mb-2">Syncing Pulse...</h3>
        <p className="text-sm text-white/20 font-medium tracking-tight">Updating Market 5M Slot...</p>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col gap-6">
      
      {/* --- ERGONOMIC SIGNAL HUD --- */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Signal Hub */}
        <div className={`relative overflow-hidden border rounded-3xl p-6 transition-all duration-500 ${isTriggered ? 'bg-emerald-500/10 border-emerald-500/40 shadow-[0_0_40px_rgba(16,185,129,0.1)]' : 'bg-white/[0.02] border-white/5'}`}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-black text-white/40 uppercase tracking-[0.2em]">Signal Delta (0.10%)</span>
            {isTriggered ? <CheckCircle2 size={16} className="text-emerald-500" /> : <XCircle size={16} className="text-white/10" />}
          </div>
          <div className="flex items-baseline gap-2 overflow-hidden">
            <div className={`text-[clamp(1.5rem,5vw,2.25rem)] font-black tracking-tighter leading-none truncate ${isTriggered ? 'text-emerald-500 animate-pulse' : 'text-white/60'}`}>
              {isTriggered ? 'SIGNAL DETECTED' : 'SCANNING...'}
            </div>
          </div>
          <div className={`mt-2 text-[10px] font-bold uppercase tracking-widest ${isTriggered ? 'text-emerald-400' : 'text-white/20'}`}>
            Variation: {isUp ? '+' : ''}{mv.binanceDeltaPct.toFixed(3)}%
          </div>
        </div>

        {/* Authorization Hub */}
        <div className={`relative overflow-hidden border rounded-3xl p-6 transition-all duration-500 ${isAuthorized ? 'bg-blue-500/10 border-blue-500/40 shadow-[0_0_40px_rgba(0,82,255,0.1)]' : 'bg-white/[0.02] border-white/5'}`}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-black text-white/40 uppercase tracking-[0.2em]">5M Trading Window</span>
            {isAuthorized ? <Zap size={16} className="text-blue-500 animate-pulse" /> : <Clock size={16} className="text-white/10" />}
          </div>
          <div className="flex items-baseline gap-2 overflow-hidden">
            <div className={`text-[clamp(1.5rem,5vw,2.25rem)] font-black tracking-tighter leading-none truncate ${isAuthorized ? 'text-blue-500' : 'text-white/60 opacity-40'}`}>
              {isAuthorized ? 'AUTHORIZED' : 'WAITING SLOT'}
            </div>
          </div>
          <div className={`mt-2 text-[10px] font-bold uppercase tracking-widest ${isAuthorized ? 'text-blue-400' : 'text-white/20'}`}>
             Slot closure in {Math.floor(secondsLeft / 60)}m {secondsLeft % 60}s
          </div>
        </div>
      </div>

      {/* --- DUAL MARKET BEST ASKS --- */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Market UP */}
        <div className="bg-[#0f111a] border border-white/5 rounded-[2rem] p-6 flex flex-col gap-1 relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <TrendingUp size={48} className="text-emerald-500" />
          </div>
          <span className="text-[9px] font-black text-white/30 uppercase tracking-[0.3em] flex items-center gap-2">
             <ArrowUpRight size={10} className="text-emerald-500" /> Polymarket UP Ask
          </span>
          <div className="text-[clamp(1.5rem,8vw,3.5rem)] font-mono font-black text-emerald-400 leading-none tracking-tighter py-2">
            {mv.bestAskUp ? (mv.bestAskUp * 100).toFixed(1) : '—'}<span className="text-xl text-emerald-500/40">¢</span>
          </div>
          <div className="text-[9px] font-bold text-white/20 uppercase tracking-widest">Strike: ${Number(mv.binanceStrike).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
        </div>

        {/* Market DOWN */}
        <div className="bg-[#0f111a] border border-white/5 rounded-[2rem] p-6 flex flex-col gap-1 relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <TrendingDown size={48} className="text-rose-500" />
          </div>
          <span className="text-[9px] font-black text-white/30 uppercase tracking-[0.3em] flex items-center gap-2">
             <ArrowDownRight size={10} className="text-rose-500" /> Polymarket DOWN Ask
          </span>
          <div className="text-[clamp(1.5rem,8vw,3.5rem)] font-mono font-black text-rose-400 leading-none tracking-tighter py-2">
            {mv.bestAskDown ? (mv.bestAskDown * 100).toFixed(1) : '—'}<span className="text-xl text-rose-500/40">¢</span>
          </div>
          <div className="text-[9px] font-bold text-white/20 uppercase tracking-widest">Strike: ${Number(mv.binanceStrike).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
        </div>
      </div>

      {/* --- SECONDARY STATS GRID --- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-4 overflow-hidden">
           <span className="text-[9px] font-black text-white/20 uppercase tracking-widest block mb-1 truncate">Binance Mid</span>
           <span className="text-base font-mono font-bold text-white/80 whitespace-nowrap">${Number(mv.binanceSpot).toLocaleString()}</span>
        </div>
        <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-4 overflow-hidden">
           <span className="text-[9px] font-black text-white/20 uppercase tracking-widest block mb-1 truncate">Delta USD</span>
           <span className={`text-base font-mono font-bold whitespace-nowrap ${isUp ? 'text-emerald-500/80' : 'text-rose-500/80'}`}>
             ${Math.abs(deltaAbs).toFixed(2)}
           </span>
        </div>
        <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-4 overflow-hidden">
           <span className="text-[9px] font-black text-white/20 uppercase tracking-widest block mb-1 truncate">Threshold</span>
           <span className="text-base font-mono font-bold text-white/40 whitespace-nowrap">${(mv.binanceStrike * 0.001).toFixed(2)}</span>
        </div>
        <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-4 overflow-hidden">
           <span className="text-[9px] font-black text-white/20 uppercase tracking-widest block mb-1 truncate">Variation</span>
           <span className={`text-base font-mono font-bold whitespace-nowrap ${isUp ? 'text-emerald-500/80' : 'text-rose-500/80'}`}>
             {isUp ? '+' : ''}{mv.binanceDeltaPct.toFixed(3)}%
           </span>
        </div>
      </div>

      {/* Decision Stream */}
      <div className="bg-black/60 rounded-3xl p-5 flex flex-col gap-3 border border-white/5 shadow-inner">
         <div className="flex items-center gap-2">
            <Info size={12} className="text-blue-400" />
            <span className="text-[10px] font-black text-white/20 uppercase tracking-[0.2em]">Signal Engine Strategy Log</span>
         </div>
         <div className="flex flex-col gap-2">
            {decisionLog && decisionLog.length > 0 ? decisionLog.map((log, i) => (
              <div key={i} className="flex items-center justify-between text-[11px] py-1 select-none">
                <div className="flex items-center gap-3 flex-1 overflow-hidden">
                   <span className={`px-2 py-0.5 rounded-md font-black text-[9px] uppercase tracking-wider shadow-lg ${log.decision === 'TRADE' || log.decision === 'BUY' ? 'bg-orange-500 text-black' : 'bg-white/10 text-white/40'}`}>
                     {log.decision}
                   </span>
                   <span className="text-white/60 truncate font-medium">{log.reason}</span>
                </div>
                <span className="text-white/20 font-mono text-[10px] ml-4">{new Date(log.at).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              </div>
            )) : (
              <div className="text-[10px] text-white/10 italic py-2">Awaiting strategy pulse from engine...</div>
            )}
         </div>
      </div>
    </div>
  );
}
