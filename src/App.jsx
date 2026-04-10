import { useEffect, useState } from 'react';
import { BotOverview } from './components/BotOverview';
import { BotStatusBadge } from './components/BotStatus';
import {
  DEFAULT_BOT_STATUS_URL,
  DEFAULT_BOT_STATUS_URL_15M,
  areBotStatusUrlsDuplicate,
} from './hooks/useBotStatus.js';

/** Ancienne page backtest retirée — évite un hash mort dans la barre d’adresse (favoris / onglet). */
const LEGACY_HASH_ROUTES = new Set(['strat-95-70']);

function stripLegacyHashFromUrl() {
  if (typeof window === 'undefined') return;
  const raw = (window.location.hash || '').replace(/^#/, '');
  if (!LEGACY_HASH_ROUTES.has(raw)) return;
  const { pathname, search } = window.location;
  window.history.replaceState(null, '', `${pathname}${search || ''}`);
}

export default function App() {
  const [clock, setClock] = useState('');

  useEffect(() => {
    stripLegacyHashFromUrl();
    const onHash = () => stripLegacyHashFromUrl();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock(`${now.toLocaleDateString('fr-FR')}  ${now.toLocaleTimeString('fr-FR')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="layout app-root bg-[#030712] min-h-screen">
      <header className="pm-header sticky top-0 z-50 backdrop-blur-xl bg-black/40 border-b border-white/5 px-8">
        <div className="logo py-2">
          <img 
            src="/polymarket-assets/logos/logo-blue-full.svg" 
            alt="Polymarket" 
            className="h-8 w-auto hover:opacity-80 transition-opacity"
          />
          <div className="h-4 w-[1px] bg-white/10 mx-2" />
          <div>
            <div className="logo-text text-sm font-bold tracking-tight text-white/90">Sniper Console</div>
            <div className="logo-sub text-blue-500 font-black uppercase tracking-[0.2em] text-[7px]">High Frequency BTC 5m</div>
          </div>
        </div>
        <div className="header-right">
          <div className="timestamp font-mono text-[10px] text-white/30 bg-white/5 px-3 py-1 rounded-full border border-white/5">{clock}</div>
        </div>
      </header>

      <div className="bots-row px-4 py-2 border-b border-white/5 bg-white/[0.01]">
        <div className="flex gap-4">
          {DEFAULT_BOT_STATUS_URL && <BotStatusBadge statusUrl={DEFAULT_BOT_STATUS_URL} label="SNIPER 5M" />}
        </div>
      </div>

      <main className="app-main">
        <BotOverview />
      </main>
    </div>
  );
}
