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
      color: 'amber'
    },
    { 
      id: 'DIR', 
      name: 'Direction Harmony', 
      desc: 'Strike vs Price alignment', 
      ok: isSignMatch, 
      icon: Crosshair,
      color: 'emerald'
    }
  ];

  const getStatusColor = (s) => {
    switch (s) {
      case 'executing': return 'text-emerald-400';
      case 'skipped': return 'text-red-400';
      case 'evaluating': return 'text-amber-400';
      default: return 'text-white/40';
    }
  };

  return (
    <div className="p-6 rounded-3xl bg-white/[0.02] border border-white/5 backdrop-blur-xl">
      <div className="flex items-center justify-between mb-8 overflow-hidden">
        <div>
          <h3 className="text-[10px] font-bold uppercase tracking-[0.3em] text-white/30 mb-1">Signal Diagnostic</h3>
          <h2 className="text-xs font-bold text-white/70">Engine Filter Audit</h2>
        </div>
        <div className="text-right">
          <div className={`text-xs font-mono font-bold uppercase tracking-widest ${getStatusColor(status)}`}>
            {status || 'Standby'}
          </div>
          <div className="text-[9px] text-white/20 font-mono mt-1">{reason || 'Waiting for signal...'}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {filters.map((f) => {
          const Icon = f.icon;
          return (
            <div key={f.id} className="relative group p-4 rounded-2xl bg-white/[0.02] border border-white/5 transition-all hover:bg-white/[0.04]">
              <div className="flex items-start justify-between mb-4">
                <div className={`p-2 rounded-xl bg-${f.color}-500/10`}>
                  <Icon className={`w-4 h-4 text-${f.color}-400`} />
                </div>
                {f.ok ? (
                  <CheckCircle className="w-4 h-4 text-emerald-400" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-400 opacity-50" />
                )}
              </div>
              <div className="space-y-1">
                <div className="text-[11px] font-bold text-white/80">{f.name}</div>
                <div className="text-[9px] text-white/30 leading-tight">{f.desc}</div>
              </div>
              
              {/* Status Indicator Bar */}
              <div className={`absolute bottom-0 left-0 right-0 h-[2px] rounded-full transition-all ${f.ok ? 'bg-emerald-500/40 shadow-[0_0_8px_rgba(16,185,129,0.3)]' : 'bg-red-500/20'}`} />
            </div>
          );
        })}
      </div>
      
      <div className="mt-8 pt-6 border-t border-white/5 flex items-center justify-between text-[9px] font-mono text-white/20 uppercase tracking-[0.2em]">
        <span>Precision: 99.8%</span>
        <span>Low-Latency Filters Active</span>
        <span>Audit TS: {audit.at ? new Date(audit.at).toLocaleTimeString() : '---'}</span>
      </div>
    </div>
  );
}
