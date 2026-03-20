import { useEffect, useState } from 'react';
import { BitcoinUpDownStrategy } from './components/BitcoinUpDownStrategy';
import { BotStatusBadge } from './components/BotStatus';
import { DEFAULT_BOT_STATUS_URL_15M } from './hooks/useBotStatus.js';
import { BotOverview } from './components/BotOverview';
import { HeaderWalletBar } from './components/HeaderWalletBar';

export default function App() {
  const [clock, setClock] = useState('');

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
          <HeaderWalletBar />
          <div className="timestamp">{clock}</div>
        </div>
      </header>

      <div className="bots-row">
        <BotStatusBadge label="BOT 1H" />
        {DEFAULT_BOT_STATUS_URL_15M && <BotStatusBadge statusUrl={DEFAULT_BOT_STATUS_URL_15M} label="BOT 15M" />}
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
