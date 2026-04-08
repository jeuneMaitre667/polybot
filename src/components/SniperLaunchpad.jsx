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
    <div className="p-8 rounded-[2rem] bg-gradient-to-br from-indigo-600/20 to-emerald-600/10 border border-white/10 backdrop-blur-2xl shadow-2xl relative overflow-hidden group">
      {/* Decorative pulse background */}
      <div className="absolute -top-24 -right-24 w-64 h-64 bg-indigo-500/10 rounded-full blur-[80px] group-hover:bg-indigo-500/20 transition-all duration-1000" />
      
      <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-8">
        <div className="space-y-4 text-center md:text-left">
          <div>
            <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-white/30 mb-2">Live Sniper Console</h3>
            <div className="flex items-center gap-3 justify-center md:justify-start">
              <h2 className="text-3xl font-bold tracking-tighter text-white">BTC 5m Sniper</h2>
              <div className="px-2 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-500/30 text-[10px] font-bold text-emerald-400">ACTIVE</div>
            </div>
          </div>
          
          <div className="flex flex-wrap gap-6 justify-center md:justify-start">
            <div className="space-y-1">
              <span className="text-[9px] uppercase font-bold text-white/40 tracking-widest">Current Slot</span>
              <div className="text-sm font-mono text-indigo-300 font-bold">{slotSlug}</div>
            </div>
            <div className="h-8 w-[1px] bg-white/5 hidden md:block" />
            <div className="space-y-1">
              <span className="text-[9px] uppercase font-bold text-white/40 tracking-widest">Time Remaining</span>
              <div className={`text-sm font-mono font-bold ${secondsLeft < 30 ? 'text-red-400 animate-pulse' : 'text-white/80'}`}>
                {Math.floor(secondsLeft / 60)}:{(secondsLeft % 60).toString().padStart(2, '0')}s
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 w-full max-w-md space-y-4">
          <div className="flex items-end justify-between px-1">
            <div className="space-y-1">
              <span className="text-[9px] uppercase font-bold text-white/40 tracking-widest">Momentum Delta</span>
              <div className={`text-2xl font-mono font-black tracking-tighter ${Number(momentumPct) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {Number(momentumPct) >= 0 ? '+' : ''}{momentumPct}%
              </div>
            </div>
            <div className="text-right space-y-1">
              <span className="text-[9px] uppercase font-bold text-white/40 tracking-widest">Strike vs Pulse</span>
              <div className="text-sm font-mono text-white/60">
                ${strike?.toLocaleString() ?? '—'} <span className="mx-1 text-white/20">/</span> <span className="text-indigo-400">${pythPrice?.toLocaleString() ?? '—'}</span>
              </div>
            </div>
          </div>

          <div className="h-4 w-full bg-white/5 rounded-full p-1 overflow-hidden border border-white/10">
            <div 
              className={`h-full rounded-full transition-all duration-500 ease-out shadow-[0_0_15px_rgba(16,185,129,0.4)] ${isMomentumGreen ? 'bg-emerald-500' : 'bg-indigo-500'}`}
              style={{ width: `${progressRatio}%` }}
            />
          </div>
          <div className="flex justify-between px-1 items-center">
             <span className="text-[8px] font-bold text-white/20 uppercase tracking-widest italic">Target: 0.100% Magnitude</span>
             <span className={`text-[8px] font-bold uppercase tracking-widest ${isMomentumGreen ? 'text-emerald-400' : 'text-white/20'}`}>
               {isMomentumGreen ? 'Ready to Fire' : 'Charging Momentum'}
             </span>
          </div>
        </div>
      </div>
    </div>
  );
}
