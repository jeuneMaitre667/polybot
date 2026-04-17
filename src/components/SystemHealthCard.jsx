import React from 'react';
import { Cpu, HardDrive, Clock, Activity, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export function SystemHealthCard({ data }) {
  if (!data) return null;

  const cpu = data.cpu || 0;
  const memoryBytes = data.memory || 0;
  const memoryMb = Math.round(memoryBytes / (1024 * 1024));
  const uptime = data.uptime;
  const pid = data.pid;

  const formatUptime = (ms) => {
    if (!ms) return '—';
    const sec = Math.floor(ms / 1000);
    const day = Math.floor(sec / 86400);
    const hr = Math.floor((sec % 86400) / 3600);
    const min = Math.floor((sec % 3600) / 60);
    if (day > 0) return `${day}d ${hr}h ${min}m`;
    if (hr > 0) return `${hr}h ${min}m`;
    return `${min}m`;
  };

  const getCpuColor = (val) => {
    if (val < 30) return 'text-emerald-400';
    if (val < 70) return 'text-amber-400';
    return 'text-red-400';
  };

  const getCpuBg = (val) => {
    if (val < 30) return 'bg-emerald-500';
    if (val < 70) return 'bg-amber-500';
    return 'bg-red-500';
  };

  return (
    <div className="space-y-8">
      <div className="section-title flex items-center gap-4">
        <h2 className="text-xl font-black tracking-tighter text-white/90 uppercase">System Diagnostics</h2>
        <div className="h-[1px] flex-1 bg-gradient-to-r from-purple-500/20 to-transparent" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* CPU USAGE */}
        <div className="card rounded-[2.5rem] border border-white/5 p-8 bg-white/[0.01] relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/5 blur-[50px] -mr-16 -mt-16 transition-opacity group-hover:opacity-100" />
          <div className="flex justify-between items-start relative z-10">
            <div className="p-3 rounded-2xl bg-purple-500/10 border border-purple-500/20 text-purple-400">
              <Cpu size={20} />
            </div>
            <div className="text-[10px] font-black text-white/40 uppercase tracking-[0.3em]">Engine Load</div>
          </div>
          
          <div className="relative z-10 mt-6">
            <div className={cn("text-4xl font-mono font-black tracking-tighter", getCpuColor(cpu))}>
              {cpu}%
            </div>
            <div className="w-full h-1 bg-white/5 rounded-full mt-4 overflow-hidden">
               <div 
                 className={cn("h-full transition-all duration-1000 ease-out", getCpuBg(cpu))}
                 style={{ width: `${Math.min(100, cpu)}%` }}
               />
            </div>
            <p className="text-[10px] text-white/20 mt-3 uppercase font-bold tracking-widest leading-relaxed">
               Virtual Core Utilization • {cpu > 80 ? 'CRITICAL STRESS' : 'OPERATIONAL'}
            </p>
          </div>
        </div>

        {/* MEMORY USAGE */}
        <div className="card rounded-[2.5rem] border border-white/5 p-8 bg-white/[0.01] relative overflow-hidden group">
          <div className="flex justify-between items-start relative z-10">
            <div className="p-3 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
              <HardDrive size={20} />
            </div>
            <div className="text-[10px] font-black text-white/40 uppercase tracking-[0.3em]">Memory Matrix</div>
          </div>
          <div className="relative z-10 mt-6">
            <div className="text-4xl font-mono font-black tracking-tighter text-white/90">
              {memoryMb} <span className="text-xl text-white/20">MB</span>
            </div>
            <div className="w-full h-1 bg-white/5 rounded-full mt-4 overflow-hidden">
               <div 
                 className="h-full bg-indigo-500 transition-all duration-1000 ease-out"
                 style={{ width: `${Math.min(100, (memoryMb / 2048) * 100)}%` }} // Assuming 2GB total
               />
            </div>
            <p className="text-[10px] text-white/20 mt-3 uppercase font-bold tracking-widest leading-relaxed">
               RAM Leak Shield: ACTIVE • GC Optimized
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
         {/* UPTIME */}
         <div className="flex items-center gap-4 p-6 rounded-3xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-all">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-500">
               <Clock size={16} />
            </div>
            <div>
               <div className="text-[10px] font-black text-white/20 uppercase tracking-widest">Bot Persistence</div>
               <div className="text-lg font-mono font-bold text-white/80">{formatUptime(uptime)}</div>
            </div>
         </div>

         {/* PID STATUS */}
         <div className="flex items-center gap-4 p-6 rounded-3xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-all">
            <div className="p-2 rounded-xl bg-blue-500/10 text-blue-500">
               <Activity size={16} />
            </div>
            <div>
               <div className="text-[10px] font-black text-white/20 uppercase tracking-widest">Instance Kernel</div>
               <div className="text-lg font-mono font-bold text-white/80">PID: {pid || 'XXXX'}</div>
            </div>
         </div>
      </div>
    </div>
  );
}
