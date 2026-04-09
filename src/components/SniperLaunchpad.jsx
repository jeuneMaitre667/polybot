import { useMemo } from 'react';

export function SniperLaunchpad({ data }) {
  const secondsLeft = data?.secondsLeftInSlot ?? 0;
  const slotSlug = data?.assetStates?.BTC?.currentSlot ?? 'Waiting...';
  const strike = data?.assetStates?.BTC?.strike;
  const pythPrice = data?.perpSources?.BTC?.pyth;
  
  const momentumDelta = data?.sniperFilterAudit?.momentumDelta ?? 0;
  const momentumPct = (momentumDelta * 100).toFixed(3);
  
  const progressRatio = useMemo(() => {
    // Progress bar fills up to 0.1% (the threshold)
    const threshold = 0.1;
    const current = Math.abs(Number(momentumPct));
    return Math.min(100, (current / threshold) * 100);
  }, [momentumPct]);

  const isMomentumGreen = Math.abs(Number(momentumPct)) >= 0.1;

  return (
    <div className="p-8 rounded-[2.5rem] bg-gradient-to-br from-blue-600/10 to-slate-900/40 border border-white/5 backdrop-blur-3xl shadow-2xl relative overflow-hidden group">
      {/* Decorative pulse background */}
      <div className="absolute -top-32 -right-32 w-80 h-80 bg-blue-500/10 rounded-full blur-[100px] group-hover:bg-blue-500/20 transition-all duration-1000" />
      
      <div className="relative z-10 flex flex-col xl:flex-row items-center justify-between gap-10">
        <div className="space-y-5 text-center xl:text-left">
          <div className="space-y-1">
            <h3 className="text-[10px] font-black uppercase tracking-[0.5em] text-white/30 mb-3">Sniper Execution Node</h3>
            <div className="flex items-center gap-4 justify-center xl:justify-start">
              <h2 className="text-4xl font-bold tracking-tighter text-white">BTC 5m</h2>
              <div className="px-3 py-1 rounded-full bg-blue-500 text-[10px] font-black text-white shadow-[0_0_20px_rgba(0,82,255,0.4)]">LIVE ENGINE</div>
            </div>
          </div>
          
          <div className="flex flex-wrap gap-8 justify-center xl:justify-start">
            <div className="space-y-1">
              <span className="text-[9px] uppercase font-bold text-white/20 tracking-widest">Active Slot</span>
              <div className="text-sm font-mono text-blue-400 font-bold tracking-tight">
                {slotSlug === 'Waiting...' ? (
                  <span className="animate-pulse">Initializing...</span>
                ) : slotSlug}
              </div>
            </div>
            <div className="h-10 w-[1px] bg-white/5 hidden xl:block" />
            <div className="space-y-1">
              <span className="text-[9px] uppercase font-bold text-white/20 tracking-widest">Time to Expiry</span>
              <div className={`text-sm font-mono font-bold ${secondsLeft < 30 ? 'text-red-400 animate-pulse' : 'text-white/80'}`}>
                {secondsLeft > 0 ? (
                  `${Math.floor(secondsLeft / 60)}:${(secondsLeft % 60).toString().padStart(2, '0')}s`
                ) : (
                  'Calculating...'
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 w-full max-w-xl space-y-6">
          <div className="flex items-end justify-between px-2">
            <div className="space-y-1">
              <span className="text-[9px] uppercase font-bold text-white/20 tracking-widest">Relative Momentum</span>
              <div className={`text-4xl font-mono font-black tracking-tighter ${Number(momentumPct) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {Number(momentumPct) > 0 ? '+' : ''}{momentumPct}%
              </div>
            </div>
            <div className="text-right space-y-1">
              <span className="text-[9px] uppercase font-bold text-white/20 tracking-widest">Oracle vs Strike</span>
              <div className="text-base font-mono font-bold text-white/90">
                {pythPrice ? (
                  <>
                    <span className="text-blue-500">${pythPrice.toLocaleString()}</span>
                    <span className="mx-2 text-white/10">/</span>
                    <span className="text-white/40">${strike?.toLocaleString() ?? 'Pending'}</span>
                  </>
                ) : (
                  <span className="text-[10px] text-white/20 uppercase animate-pulse">Waiting for Liquidity...</span>
                )}
              </div>
            </div>
          </div>

          <div className="h-5 w-full bg-white/5 rounded-2xl p-1 overflow-hidden border border-white/10 shadow-inner">
            <div 
              className={`h-full rounded-xl transition-all duration-700 ease-out ${isMomentumGreen ? 'bg-gradient-to-r from-emerald-500 to-emerald-400 shadow-[0_0_25px_rgba(16,185,129,0.5)]' : 'bg-gradient-to-r from-blue-600 to-blue-500 shadow-[0_0_20px_rgba(0,82,255,0.4)]'}`}
              style={{ width: `${progressRatio}%` }}
            />
          </div>
          <div className="flex justify-between px-2 items-center">
             <div className="flex items-center gap-2">
               <div className={`w-1.5 h-1.5 rounded-full ${isMomentumGreen ? 'bg-emerald-500 animate-pulse' : 'bg-white/20'}`} />
               <span className="text-[8px] font-bold text-white/20 uppercase tracking-widest">Thresh: 0.100%</span>
             </div>
             <span className={`text-[10px] font-black uppercase tracking-[0.2em] ${isMomentumGreen ? 'text-emerald-400' : 'text-white/20'}`}>
               {isMomentumGreen ? 'Optimal Delta Reached' : 'Collecting Momentum...'}
             </span>
          </div>
        </div>
      </div>
    </div>
  );
}
