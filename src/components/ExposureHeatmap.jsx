import React from 'react';
import { LayoutGrid, ShieldCheck, AlertCircle } from 'lucide-react';

const ExposureHeatmap = ({ data }) => {
  const maxSlots = data?.maxConcurrentPositions || 10;
  
  // Dans le dashboard, on peut récupérer les positions actives depuis data.activePositions
  // Si non dispo, on fallback sur une simulation visuelle basée sur le nombre de positions.
  const activePositions = data?.activePositions || [];
  const occupiedSlots = activePositions.filter(p => !p.resolved).length;
  
  const slots = Array.from({ length: maxSlots }, (_, i) => ({
    id: i,
    occupied: i < occupiedSlots,
    asset: i < occupiedSlots ? (activePositions.filter(p => !p.resolved)[i]?.underlying || '???') : null
  }));

  const getStatusColor = (asset) => {
    if (!asset) return 'bg-slate-800/30 border-slate-700/50';
    if (asset === 'BTC') return 'bg-orange-500/20 border-orange-500/40 text-orange-400';
    if (asset === 'ETH') return 'bg-blue-500/20 border-blue-500/40 text-blue-400';
    if (asset === 'SOL') return 'bg-purple-500/20 border-purple-500/40 text-purple-400';
    return 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400';
  };

  return (
    <div className="glass-panel p-6 rounded-2xl border border-white/5 bg-black/20 backdrop-blur-md">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-500/10 rounded-lg">
            <LayoutGrid className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white/90 leading-none">Global Exposure Matrix</h3>
            <p className="text-[10px] text-slate-500 mt-1 uppercase tracking-tighter">Concurrent Slot Allocation</p>
          </div>
        </div>
        
        <div className="px-3 py-1 bg-white/5 rounded-full border border-white/10">
          <span className="text-xs font-mono text-white/70">
            <span className={occupiedSlots >= maxSlots ? 'text-red-400' : 'text-emerald-400'}>{occupiedSlots}</span>
            <span className="text-white/20mx-1">/</span>
            {maxSlots}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-3">
        {slots.map((slot) => (
          <div 
            key={slot.id}
            className={`
              h-12 rounded-xl border flex flex-col items-center justify-center transition-all duration-500
              ${getStatusColor(slot.asset)}
              ${slot.occupied ? 'shadow-[0_0_15px_rgba(99,102,241,0.1)]' : 'hover:border-white/10'}
            `}
          >
            {slot.occupied ? (
              <>
                <span className="text-[10px] font-black">{slot.asset}</span>
                <div className="w-1 h-1 rounded-full bg-current mt-1 animate-pulse" />
              </>
            ) : (
              <div className="w-1.5 h-1.5 rounded-full bg-white/5" />
            )}
          </div>
        ))}
      </div>

      <div className="mt-6 pt-4 border-t border-white/5 flex items-center justify-between text-[10px]">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-slate-500">
             <div className="w-2 h-2 rounded-full bg-slate-800" />
             Free
          </div>
          <div className="flex items-center gap-1.5 text-orange-400">
             <div className="w-2 h-2 rounded-full bg-orange-500" />
             BTC
          </div>
        </div>
        
        {occupiedSlots >= maxSlots && (
          <div className="flex items-center gap-1.5 text-red-400 animate-bounce">
            <AlertCircle className="w-3 h-3" />
            CAPACITY REACHED
          </div>
        )}
      </div>
    </div>
  );
};

export default ExposureHeatmap;
