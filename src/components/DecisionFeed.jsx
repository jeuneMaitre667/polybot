import React from 'react';
import { Terminal, Clock, Briefcase, Activity } from 'lucide-react';

export function DecisionFeed({ feed }) {
  if (!feed || feed.length === 0) return null;

  return (
    <div className="decision-feed glass-panel h-[320px] flex flex-col mt-4">
      <div className="panel-header border-b border-white/5 pb-2">
        <Terminal className="text-emerald-400" size={16} />
        <h3 className="text-xs font-semibold tracking-wider uppercase opacity-60">Decision Pipeline</h3>
        <span className="text-[10px] ml-auto opacity-30 font-mono tracking-tighter">LIVE_DATA_STREAM_0x24</span>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 p-2 font-mono text-[11px] space-y-1">
        {feed.map((entry, idx) => {
          const isBuy = entry.decision?.startsWith('BUY');
          const isWait = entry.decision === 'WAIT';
          const time = entry.at ? new Date(entry.at).toLocaleTimeString('fr-FR', { hour12: false }) : '';
          
          return (
            <div key={idx} className={`decision-entry flex items-center gap-2 p-1 rounded-sm ${isBuy ? 'bg-red-950/30 border-l-2 border-red-500' : 'hover:bg-white/5'} transit-color`}>
              <span className="opacity-30 whitespace-nowrap">[{time}]</span>
              <span className="text-blue-400 font-bold whitespace-nowrap">{(entry.gap * 100).toFixed(2)}% GAP</span>
              <span className="opacity-40 whitespace-nowrap flex items-center gap-1">
                <Activity size={10} /> {(entry.vol * 100).toFixed(1)}% VOL
              </span>
              <span className={`px-1.5 rounded-sm font-bold ${isBuy ? 'text-red-400' : isWait ? 'text-emerald-400/50' : 'text-gray-500'}`}>
                {entry.decision}
              </span>
              <span className="text-[10px] opacity-20 truncate italic">/ {entry.slug}</span>
            </div>
          );
        })}
      </div>
      
      <div className="p-2 border-t border-white/5 flex justify-between items-center opacity-30 select-none">
        <div className="text-[9px] flex items-center gap-2">
           <Activity size={10} className="animate-pulse" /> SYSTEM_THINKING_ACTIVE
        </div>
        <div className="text-[9px]">{feed.length} EVENTS TRACEABLE</div>
      </div>
    </div>
  );
}
