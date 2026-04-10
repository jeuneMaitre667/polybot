import { useMemo } from 'react';
import { TrendingUp, TrendingDown, Target, Clock, ArrowRight, Loader2, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function SniperLaunchpad({ data }) {
  const btcHUD = data?.sniperHUD?.btc;
  const strike = btcHUD?.strike ?? data?.assetStates?.BTC?.strike;
  const spotPrice = btcHUD?.spot ?? data?.perpSources?.BTC?.pyth;
  
  // Real-time Strike Sync status
  const isSyncing = btcHUD?.isStrikeOfficial === false || !strike;

  const deltaAbs = btcHUD?.deltaAbs ?? (spotPrice && strike ? spotPrice - strike : 0);
  const deltaPct = btcHUD?.deltaPct ?? (strike > 0 ? (deltaAbs / strike) * 100 : 0);
  const secondsLeft = btcHUD?.secondsLeft ?? data?.secondsLeftInSlot ?? 0;
  const slotSlug = btcHUD?.slotSlug ?? data?.assetStates?.BTC?.currentSlot ?? 'Initializing...';
  
  const isUp = deltaAbs >= 0;

  return (
    <div className="relative group">
      {/* Background Glow */}
      <div className={cn(
        "absolute -inset-1 rounded-[2.8rem] blur opacity-25 transition duration-1000",
        isSyncing ? "bg-amber-500/20" : "bg-gradient-to-r from-blue-600 to-cyan-500"
      )}></div>
      
      <div className="relative p-8 rounded-[2.5rem] bg-[#030712] border border-white/10 backdrop-blur-3xl shadow-2xl overflow-hidden">
        {/* Polymarket Style Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-blue-500/10 border border-blue-500/20">
              <div className="w-5 h-5 flex items-center justify-center font-bold text-blue-500 text-[10px]">₿</div>
            </div>
            <div>
              <h2 className="text-lg font-black tracking-tight text-white leading-none">Bitcoin Up or Down</h2>
              <span className="text-[10px] text-white/30 uppercase font-bold tracking-widest">5 Minutes Prediction</span>
            </div>
          </div>
          
          <div className={cn(
            "flex items-center gap-2 px-4 py-1.5 rounded-full border transition-all duration-500",
            isSyncing 
              ? "bg-amber-500/10 border-amber-500/20 text-amber-500" 
              : "bg-blue-500/10 border-blue-500/20 text-blue-500"
          )}>
            {isSyncing ? <Loader2 size={10} className="animate-spin" /> : <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />}
            <span className="text-[9px] font-black uppercase tracking-widest">
              {isSyncing ? 'Syncing Official API...' : 'Gamma Sync Locked'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
          {/* Main Price Card */}
          <div className="space-y-6">
            <div className="p-6 rounded-3xl bg-white/[0.02] border border-white/5 relative overflow-hidden group/card text-center md:text-left">
              <div className="absolute top-0 right-0 p-4 opacity-[0.03] group-hover/card:opacity-[0.06] transition-opacity">
                <Target size={120} />
              </div>
              <span className="text-[10px] uppercase font-black text-white/20 tracking-[0.2em] block mb-2">Price to Beat (Strike)</span>
              
              <div className="flex items-center justify-center md:justify-start gap-3">
                <div className={cn(
                  "text-5xl font-mono font-black tracking-tighter transition-all duration-700",
                  isSyncing ? "text-white/40 blur-[1px]" : "text-white"
                )}>
                  ${strike && strike > 0 ? strike.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '---.--'}
                </div>
                {isSyncing && (
                   <div className="px-2 py-1 rounded bg-white/5 text-[8px] font-bold text-white/30 uppercase animate-pulse border border-white/10">
                     Verifying...
                   </div>
                )}
              </div>

              <div className="mt-4 flex items-center gap-2 justify-center md:justify-start">
                <Link2 size={10} className="text-white/20" />
                <span className="text-[9px] text-white/40 uppercase font-bold">Slot Ref:</span>
                <span className="text-[10px] font-mono text-blue-400 font-bold">{slotSlug}</span>
              </div>
            </div>

            <div className="flex items-center gap-4 px-2">
              <div className="flex-1 space-y-1">
                <span className="text-[9px] uppercase font-bold text-white/20 tracking-widest block">Spot Price</span>
                <div className="text-2xl font-mono font-bold text-white/90">
                  ${spotPrice > 0 ? spotPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '---.--'}
                </div>
              </div>
              <ArrowRight className="text-white/20" size={16} />
              <div className="flex-1 space-y-1 text-right">
                <span className="text-[9px] uppercase font-bold text-white/20 tracking-widest block">Live Delta</span>
                <div className={cn(
                  "text-2xl font-mono font-bold flex items-center justify-end gap-1.5",
                  isSyncing ? "text-white/20" : (isUp ? 'text-emerald-400' : 'text-red-400')
                )}>
                   {!isSyncing && (isUp ? <TrendingUp size={18} /> : <TrendingDown size={18} />)}
                   {isSyncing ? '0.00' : (isUp ? '+' : '') + deltaAbs.toFixed(2)}$
                </div>
              </div>
            </div>
          </div>

          {/* Odds & Indicators */}
          <div className="space-y-8">
            <div className="relative">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[10px] uppercase font-black text-white/30 tracking-[0.2em]">Live Market Probabilities</span>
                <div className={cn(
                  "text-[12px] font-black uppercase tracking-widest px-3 py-1 rounded-lg bg-white/5 border border-white/5",
                  isUp ? "text-emerald-400" : "text-red-400"
                )}>
                  {isSyncing ? 'Calculating' : (isUp ? 'UP Wins' : 'DOWN Wins')}
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-3 h-24">
                <div className={cn(
                  "rounded-3xl flex flex-col items-center justify-center transition-all duration-700 border",
                  isUp ? "bg-blue-600/20 border-blue-500/30 text-blue-400" : "bg-white/[0.02] border-white/5 text-white/10"
                )}>
                  <span className="text-[8px] font-black opacity-40 mb-1 tracking-tighter">YES / UP</span>
                  <div className="text-xl font-mono font-black">
                     ${btcHUD?.upPrice ? btcHUD.upPrice.toFixed(2) : '--'}
                  </div>
                </div>
                <div className={cn(
                  "rounded-3xl flex flex-col items-center justify-center transition-all duration-700 border",
                  !isUp ? "bg-red-600/20 border-red-500/30 text-red-400" : "bg-white/[0.02] border-white/5 text-white/10"
                )}>
                  <span className="text-[8px] font-black opacity-40 mb-1 tracking-tighter">NO / DOWN</span>
                  <div className="text-xl font-mono font-black">
                     ${btcHUD?.downPrice ? btcHUD.downPrice.toFixed(2) : '--'}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
               <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/5 space-y-2">
                 <div className="flex items-center gap-2 text-white/20">
                   <Clock size={12} />
                   <span className="text-[9px] uppercase font-bold tracking-widest">Time to Expiry</span>
                 </div>
                 <div className={`text-xl font-mono font-bold ${secondsLeft < 30 ? 'text-amber-400 animate-pulse' : 'text-white/60'}`}>
                   {Math.floor(secondsLeft / 60)}m {secondsLeft % 60}s
                 </div>
               </div>
               <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/5 space-y-2">
                 <div className="flex items-center gap-2 text-white/20">
                   <Target size={12} />
                   <span className="text-[9px] uppercase font-bold tracking-widest">Edge %</span>
                 </div>
                 <div className={cn(
                   "text-xl font-mono font-bold",
                   isSyncing ? "text-white/20" : (isUp ? 'text-emerald-400' : 'text-red-400')
                 )}>
                   {isSyncing ? '0.000' : (isUp ? '+' : '') + deltaPct.toFixed(3)}%
                 </div>
               </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
