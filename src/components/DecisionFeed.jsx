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
    <div className="flex flex-col h-full bg-black/20">
      <div className="p-3 border-b border-white/5 flex items-center gap-2">
        <Terminal className="text-blue-400" size={14} />
        <h3 className="text-[10px] font-bold tracking-widest uppercase opacity-60">Decision Pipeline</h3>
        <div className="ml-auto flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-[9px] font-bold text-blue-400">
           <div className="w-1 h-1 rounded-full bg-blue-400 animate-pulse" /> LIVE
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 font-mono text-[11px] space-y-2">
        {feed.map((entry, idx) => {
          const isBuy = entry.decision?.startsWith('BUY');
          const time = entry.at ? new Date(entry.at).toLocaleTimeString('fr-FR', { hour12: false }) : '';
          const asset = entry.asset || 'BTC';
          const assetColors = {
            BTC: 'text-[var(--btc-gold)]',
            ETH: 'text-[var(--eth-blue)]',
            SOL: 'text-[var(--sol-purple)]',
          };
          
          return (
            <div key={idx} className={cn(
              "decision-entry flex items-start gap-3 p-2 rounded-lg border border-white/0 transition-all duration-200",
              isBuy ? "bg-red-500/10 border-red-500/20 shadow-[0_0_12px_rgba(239,68,68,0.05)]" : "hover:bg-white/5"
            )}>
              <span className="opacity-20 text-[9px] mt-0.5">[{time}]</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={cn("font-bold px-1.5 py-0.5 rounded bg-white/5 text-[9px] tracking-wider", assetColors[asset])}>
                    {asset}
                  </span>
                  <span className={cn("text-[10px] font-bold", isBuy ? "text-red-400" : "text-emerald-400/60")}>
                    {entry.decision}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10px] opacity-40">
                  <span className="flex items-center gap-1">
                    <Activity size={10} /> 
                    {entry.edge != null ? `${(entry.edge * 100).toFixed(2)}% EDGE` : `${(entry.gap * 100).toFixed(2)}% GAP`}
                  </span>
                  {entry.prob != null && (
                    <span className="flex items-center gap-1 text-blue-400/80">
                      PROB: {(entry.prob * 100).toFixed(1)}%
                    </span>
                  )}
                  {entry.ask != null && (
                    <span className="flex items-center gap-1 opacity-60">
                      ASK: {(entry.ask * 100).toFixed(1)}¢
                    </span>
                  )}
                  <span className="truncate italic opacity-50">/ {entry.slug?.split('-').slice(0, 2).join('-')}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      
      <div className="p-3 border-t border-white/5 flex justify-between items-center opacity-30 select-none bg-black/40">
        <div className="text-[9px] flex items-center gap-2 uppercase tracking-tighter">
           <div className="w-1 h-1 rounded-full bg-green-400 animate-ping" /> Analyzing Signals
        </div>
        <div className="text-[9px] font-mono">{feed.length} EVENTS</div>
      </div>
    </div>
  );
}
