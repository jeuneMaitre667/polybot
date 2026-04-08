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
    <div className="layout app-root bg-black min-h-screen">
      <header className="pm-header sticky top-0 z-50 backdrop-blur-md bg-black/60 border-b border-white/5">
        <div className="logo">
          <div className="logo-mark bg-indigo-600 shadow-[0_0_15px_rgba(79,70,229,0.4)]">PM</div>
          <div>
            <div className="logo-text">Polymarket Sniper</div>
            <div className="logo-sub text-indigo-400 font-bold uppercase tracking-widest text-[8px]">BTC 5m Console</div>
          </div>
        </div>
        <div className="header-right">
          <div className="timestamp font-mono text-white/40">{clock}</div>
        </div>
      </header>

      <div className="bots-row px-4 py-2 border-b border-white/5 bg-white/[0.01]">
        {areBotStatusUrlsDuplicate(DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M) ? (
          <BotStatusBadge statusUrl={DEFAULT_BOT_STATUS_URL} label="SNIPER NODE" />
        ) : (
          <div className="flex gap-4">
            {DEFAULT_BOT_STATUS_URL && <BotStatusBadge statusUrl={DEFAULT_BOT_STATUS_URL} label="NODE 1H" />}
            {DEFAULT_BOT_STATUS_URL_15M && <BotStatusBadge statusUrl={DEFAULT_BOT_STATUS_URL_15M} label="SNIPER NODE" />}
          </div>
        )}
      </div>

      <main className="app-main">
        <BotOverview />
      </main>
    </div>
  );
}
