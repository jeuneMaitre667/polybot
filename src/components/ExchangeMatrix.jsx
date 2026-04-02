import React from 'react';
import { Database, Activity, RefreshCcw, LayoutGrid } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ExchangeMatrix({ data }) {
  if (!data || !data.health) return null;

  const assets = ['BTC', 'ETH', 'SOL'];
  const exchanges = ['binance', 'okx', 'hyper'];
  const perpSources = data.health.perpSources || {};
  const clSources = data.health.chainlinkSources || {};

  return (
    <div className="card glass-panel flex flex-col gap-4 border border-white/5 bg-black/20 p-6 rounded-2xl shadow-xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-blue-400">
          <Database size={16} /> Data Flux Matrix
        </div>
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/20 text-[10px] font-bold text-green-400">
          <RefreshCcw size={10} className="animate-spin" /> Live Syncing
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/5 uppercase font-mono text-[9px] opacity-40">
              <th className="pb-3 pr-4">Data Stream</th>
              <th className="pb-3 text-center">Binance</th>
              <th className="pb-3 text-center">OKX</th>
              <th className="pb-3 text-center">Hyperliquid</th>
              <th className="pb-3 text-right">Chainlink Oracle</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {assets.map(asset => {
              const perp = perpSources[asset] || {};
              const cl = clSources[asset] || {};
              
              return (
                <tr key={asset} className="group hover:bg-white/[0.02] transition-colors">
                  <td className="py-4 pr-4">
                    <div className="flex items-center gap-2">
                       <span className="text-xs font-bold font-mono tracking-tighter text-white">{asset}</span>
                       <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 opacity-40 uppercase tracking-widest font-mono">SWAP</span>
                    </div>
                  </td>
                  
                  {exchanges.map(ex => (
                    <td key={ex} className="py-4 text-center">
                      <div className="flex flex-col items-center gap-1">
                        <div className={cn("w-1.5 h-1.5 rounded-full", perp[ex] > 0 ? "bg-green-400 shadow-[0_0_6px_var(--green)]" : "bg-red-500")} />
                        <span className="text-[9px] font-mono opacity-60">
                          {perp[ex] > 0 ? `${perp[ex].toFixed(1)}` : '—'}
                        </span>
                      </div>
                    </td>
                  ))}

                  <td className="py-4 text-right">
                    <div className="flex flex-col items-end gap-1">
                       <div className="flex items-center gap-2">
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 uppercase tracking-widest font-mono">Oracle</span>
                          <div className={cn("w-2 h-2 rounded-full", cl.lastPrice > 0 ? "bg-green-400" : "bg-red-400")} />
                       </div>
                       <span className="text-[9px] font-mono opacity-80 text-white">
                         {cl.lastPrice > 0 ? `$${cl.lastPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : 'OFFLINE'}
                       </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between pt-4 border-t border-white/5 opacity-30 text-[9px] uppercase tracking-widest font-mono">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1"><LayoutGrid size={10} /> 12 Active Streams</div>
          <div className="flex items-center gap-1"><Activity size={10} /> Latency Peak: 56ms</div>
        </div>
        <span>{clSources?.BTC?.rpc || 'Alchemy/Polygon Mainnet'}</span>
      </div>
    </div>
  );
}
