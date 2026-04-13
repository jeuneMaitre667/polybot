import { Terminal, Activity } from 'lucide-react';
import { cn } from '@/lib/utils';

export function DecisionFeed({ feed }) {
  if (!feed || feed.length === 0) return (
    <div className="flex flex-col items-center justify-center h-full opacity-20 font-mono text-[10px] gap-2 uppercase tracking-widest">
      <Activity size={20} />
      Waiting for decisions...
    </div>
  );

  return (
    <div className="flex flex-col h-full bg-[#030712]/40 backdrop-blur-2xl">
      <div className="p-4 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <Terminal className="text-blue-500" size={14} />
          </div>
          <h3 className="text-[10px] font-black tracking-[0.3em] uppercase text-white/40">Decision Pipeline</h3>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-[9px] font-black text-blue-500">
           <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shadow-[0_0_8px_rgba(0,82,255,0.8)]" /> ENGINE TUNED
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 font-mono text-[11px] space-y-3">
        {feed.map((entry, idx) => {
          const isBuy = entry.decision?.startsWith('BUY') || entry.reason?.includes('order_placed');
          const time = entry.at ? new Date(entry.at).toLocaleTimeString('fr-FR', { hour12: false }) : '';
          const asset = entry.asset || 'BTC';
          
          const formatReason = (reason) => {
            if (!reason) return 'Active Analysis...';
            const mapping = {
              'latency_exceeded': 'Signal Skipped: Network Lag (Stale)',
              'missing_strike_data': 'Analysis Failed: Strike Data Empty',
              'momentum_insufficient': 'Momentum below Threshold (<0.1%)',
              'momentum_inverse': 'Momentum Direction Mismatch',
              'order_placed': 'TRADE EXECUTED',
              'correlation_limit': 'Risk Limit: Correlation High',
              'already_traded': 'Slot Guard: Already Traded',
              'strike_not_at_boundary': 'Wait: Strike Boundary Delay'
            };
            return mapping[reason] || reason.replace(/_/g, ' ').toUpperCase();
          };

          return (
            <div key={idx} className={cn(
              "decision-entry flex items-start gap-4 p-3 rounded-xl border border-white/5 bg-white/[0.01] transition-all duration-300 hover:bg-white/[0.03] hover:border-white/10",
              isBuy ? "border-emerald-500/20 bg-emerald-500/5 shadow-[0_0_20px_rgba(16,185,129,0.05)]" : ""
            )}>
              <span className="text-white/10 text-[9px] font-bold mt-1 tabular-nums">[{time}]</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-black px-2 py-0.5 rounded bg-blue-500 text-white text-[8px] tracking-[0.1em] uppercase">
                    {asset}
                  </span>
                  <span className={cn("text-[11px] font-bold tracking-tight uppercase", isBuy ? "text-emerald-400" : "text-white/60")}>
                    {entry.decision || formatReason(entry.reason)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-[10px]">
                  <span className="flex items-center gap-1.5 text-white/30">
                    <Activity size={10} className="text-blue-500/50" /> 
                    {entry.edge != null ? (
                      <span className="font-bold">{(entry.edge * 100).toFixed(2)}% <span className="text-[8px] opacity-50 uppercase tracking-tighter">Edge</span></span>
                    ) : entry.gap != null ? (
                      <span className="font-bold">{(entry.gap * 100).toFixed(2)}% <span className="text-[8px] opacity-50 uppercase tracking-tighter">Gap</span></span>
                    ) : null}
                  </span>
                  {entry.prob != null && (
                    <span className="flex items-center gap-1.5 text-blue-400 font-bold">
                      {(entry.prob * 100).toFixed(1)}% <span className="text-[8px] opacity-50 uppercase tracking-tighter">Prob</span>
                    </span>
                  )}
                  {entry.ask != null && (
                    <span className="flex items-center gap-1 opacity-60">
                      {(entry.ask * 100).toFixed(1)}¢ <span className="text-[8px] opacity-50 uppercase tracking-tighter">Ask</span>
                    </span>
                  )}
                  <span className="truncate italic text-white/20 text-[9px]">/ {entry.slug?.split('-').slice(0, 2).join('-')}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      
      <div className="p-4 border-t border-white/5 flex justify-between items-center bg-black/40">
        <div className="text-[9px] flex items-center gap-2 uppercase font-black tracking-[0.2em] text-white/20">
           <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" /> Analyzers Standby
        </div>
        <div className="text-[10px] font-mono font-bold text-white/40 bg-white/5 px-2 py-0.5 rounded">{feed.length} EVENTS</div>
      </div>
    </div>
  );
}
