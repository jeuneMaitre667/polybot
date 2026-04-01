import { useEffect, useState } from 'react';
import { BotOverview } from './components/BotOverview';
import { BitcoinUpDownStrategy } from './components/BitcoinUpDownStrategy';
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
    <div className="layout app-root">
      <header className="pm-header">
        <div className="logo">
          <div className="logo-mark">PM</div>
          <div>
            <div className="logo-text">Polymarket Bot</div>
            <div className="logo-sub">Trading Dashboard</div>
          </div>
        </div>
        <div className="header-right">
          <div className="timestamp">{clock}</div>
        </div>
      </header>

      <div className="bots-row">
        {areBotStatusUrlsDuplicate(DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M) ? (
          <>
            <BotStatusBadge statusUrl={DEFAULT_BOT_STATUS_URL} label="BOT 15M" />
            <span
              className="bots-row-hint"
              title="Le serveur de statut ne renvoie qu’un seul état PM2. Pour afficher le bot horaire séparément, définissez VITE_BOT_STATUS_URL vers l’URL du statut sur l’instance 1h (IP ou port différent du 15m)."
            >
              Même URL que 1h : le statut horaire n’est pas indépendant. Utilisez une URL dédiée pour le bot 1h.
            </span>
          </>
        ) : (
          <>
            {DEFAULT_BOT_STATUS_URL ? (
              <BotStatusBadge statusUrl={DEFAULT_BOT_STATUS_URL} label="BOT 1H" />
            ) : (
              <span className="bots-row-hint" title="Définissez VITE_BOT_STATUS_URL quand un bot horaire sera de nouveau connecté.">
                Bot 1h : non configuré
              </span>
            )}
            {DEFAULT_BOT_STATUS_URL_15M && (
              <BotStatusBadge statusUrl={DEFAULT_BOT_STATUS_URL_15M} label="BOT 15M" />
            )}
          </>
        )}
      </div>

      <main className="app-main app-main--flat">
        <div className="section-title">
          <h2>Solde &amp; Performance</h2>
          <div className="line" />
        </div>
        <div className="app-stack app-stack--tight">
          <BotOverview />

          <div className="section-title">
            <h2>Stratégie &amp; Backtest</h2>
            <div className="line" />
          </div>
          <div className="app-strat-full">
            <BitcoinUpDownStrategy />
          </div>
        </div>
      </main>
    </div>
  );
}
