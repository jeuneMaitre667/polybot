import React from 'react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  Legend
} from 'recharts';

const LatencyTimelineChart = ({ data }) => {
  if (!data || (!data.ws?.length && !data.poll?.length)) {
    return (
      <div className="flex items-center justify-center h-48 bg-slate-900/50 rounded-xl border border-slate-800">
        <span className="text-slate-500 text-sm italic">En attente de données de latence...</span>
      </div>
    );
  }

  // Fusionner et formater pour recharts
  const chartData = [];
  const wsData = data.ws || [];
  const pollData = data.poll || [];
  
  // Utiliser le temps du dernier échantillon comme point de référence
  const lastTs = Math.max(
    wsData.length ? wsData[wsData.length-1].t : 0,
    pollData.length ? pollData[pollData.length-1].t : 0
  );

  // Créer un dataset unifié (on prend les indices pour l'axe X)
  const maxLen = Math.max(wsData.length, pollData.length);
  for (let i = 0; i < maxLen; i++) {
    const entry = { index: i };
    if (wsData[i]) entry.ws = wsData[i].v;
    if (pollData[i]) entry.poll = pollData[i].v;
    chartData.push(entry);
  }

  return (
    <div className="bg-slate-900/40 p-4 rounded-xl border border-slate-800 backdrop-blur-sm h-64">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
          Latency Timeline (WS & Poll)
        </h3>
        <span className="text-[10px] text-slate-500 font-mono">Last 100 samples</span>
      </div>
      
      <ResponsiveContainer width="100%" height="80%">
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
          <XAxis 
            dataKey="index" 
            hide 
          />
          <YAxis 
            stroke="#64748b" 
            fontSize={10} 
            tickFormatter={(value) => `${value}ms`}
            domain={[0, 'auto']}
          />
          <Tooltip 
            contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', fontSize: '12px' }}
            itemStyle={{ fontSize: '12px' }}
            labelStyle={{ display: 'none' }}
          />
          <Legend iconType="circle" wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} />
          <Line 
            type="monotone" 
            dataKey="ws" 
            name="WebSocket" 
            stroke="#6366f1" 
            strokeWidth={2} 
            dot={false}
            animationDuration={300}
          />
          <Line 
            type="monotone" 
            dataKey="poll" 
            name="Cycle Poll" 
            stroke="#10b981" 
            strokeWidth={2} 
            dot={false}
            animationDuration={300}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default LatencyTimelineChart;
