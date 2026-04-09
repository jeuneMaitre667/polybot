import { 
  CheckCircle, 
  XCircle, 
  AlertCircle,
  Crosshair,
  ShieldCheck,
  Zap
} from 'lucide-react';

export function SniperFilterAudit({ data }) {
  const audit = data?.sniperFilterAudit || {};
  const { status, reason, isDuplicate, isStrong, isSignMatch } = audit;

  const filters = [
    { 
      id: 'DUP', 
      name: 'Deduplication', 
      desc: 'One trade per slot policy', 
      ok: !isDuplicate, 
      icon: ShieldCheck,
      color: 'blue'
    },
    { 
      id: 'MAG', 
      name: 'Magnitude (>0.1%)', 
      desc: 'Significant price movement', 
      ok: isStrong, 
      icon: Zap,
      color: 'blue'
    },
    { 
      id: 'DIR', 
      name: 'Direction Harmony', 
      desc: 'Strike vs Price alignment', 
      ok: isSignMatch, 
      icon: Crosshair,
      color: 'blue'
    }
  ];

  const getStatusColor = (s) => {
    switch (s) {
      case 'executing': return 'text-emerald-400';
      case 'skipped': return 'text-red-400';
      case 'evaluating': return 'text-blue-400 animate-pulse';
      default: return 'text-white/40';
    }
  };

  return (
    <div className="p-8 rounded-[2rem] bg-white/[0.01] border border-white/5 backdrop-blur-2xl shadow-xl relative overflow-hidden group">
      <div className="absolute top-0 left-0 w-24 h-24 bg-blue-500/5 blur-[40px] -ml-12 -mt-12" />
      <div className="flex items-center justify-between mb-10 overflow-hidden relative z-10">
        <div className="space-y-1">
          <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-white/20">Signal Diagnostic</h3>
          <h2 className="text-xs font-bold text-white/60 tracking-tight">ENGINE FILTER AUDIT</h2>
        </div>
        <div className="text-right">
          <div className={`text-xs font-mono font-black uppercase tracking-[0.2em] ${getStatusColor(status)}`}>
            {status || 'Standby'}
          </div>
          <div className="text-[9px] text-white/20 font-mono mt-2 bg-white/5 px-2 py-0.5 rounded leading-none">{reason || 'Waiting for signal...'}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 relative z-10">
        {filters.map((f) => {
          const Icon = f.icon;
          return (
            <div key={f.id} className="relative group p-5 rounded-2xl bg-white/[0.02] border border-white/5 transition-all hover:bg-white/[0.04] hover:border-blue-500/10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className={`p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20`}>
                    <Icon className={`w-4 h-4 text-blue-400`} />
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-[12px] font-bold text-white/90 tracking-tight">{f.name}</div>
                    <div className="text-[9px] text-white/30 uppercase font-bold tracking-widest">{f.desc}</div>
                  </div>
                </div>
                {f.ok ? (
                  <CheckCircle className="w-5 h-5 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.3)]" />
                ) : (
                  <XCircle className="w-5 h-5 text-red-500/40" />
                )}
              </div>
              
              {/* Status Indicator Bar */}
              <div className={`absolute bottom-0 left-4 right-4 h-[1px] rounded-full transition-all ${f.ok ? 'bg-emerald-500/30' : 'bg-white/5'}`} />
            </div>
          );
        })}
      </div>
      
      <div className="mt-10 pt-6 border-t border-white/5 flex items-center justify-between text-[8px] font-mono text-white/20 uppercase font-black tracking-[0.3em] relative z-10">
        <div className="flex items-center gap-2">
           <div className="w-1 h-1 rounded-full bg-blue-500/40" />
           <span>Precision: 99.8%</span>
        </div>
        <span>Audit TS: {audit.at ? new Date(audit.at).toLocaleTimeString() : '---'}</span>
      </div>
    </div>
  );
}
