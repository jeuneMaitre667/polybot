import React, { useEffect, useRef } from 'react';

export function BinanceChartCard() {
  const container = useRef();

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      "autosize": true,
      "symbol": "BINANCE:BTCUSDC",
      "interval": "5",
      "timezone": "Etc/UTC",
      "theme": "dark",
      "style": "1",
      "locale": "en",
      "enable_publishing": false,
      "allow_symbol_change": false,
      "calendar": false,
      "support_host": "https://www.tradingview.com",
      "backgroundColor": "rgba(3, 7, 18, 1)", // Match our app background
      "gridColor": "rgba(255, 255, 255, 0.05)",
      "hide_top_toolbar": true,
      "save_image": false
    });
    
    if (container.current) {
        container.current.innerHTML = '';
        container.current.appendChild(script);
    }
  }, []);

  return (
    <div className="bg-[#030712] border border-white/5 rounded-[2.5rem] overflow-hidden group shadow-2xl h-[500px] flex flex-col">
      <div className="flex items-center justify-between px-8 py-4 bg-white/[0.02] border-b border-white/5">
         <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center border border-orange-500/20">
               <span className="text-orange-500 font-black text-[10px]">B</span>
            </div>
            <h3 className="text-xs font-black text-white/40 uppercase tracking-[0.2em]">Binance BTC / USDC <span className="text-white/20 ml-2">5M Interval</span></h3>
         </div>
      </div>
      <div className="flex-1 relative">
        <div className="tradingview-widget-container h-full" ref={container}>
          <div className="tradingview-widget-container__widget h-full"></div>
        </div>
      </div>
    </div>
  );
}
