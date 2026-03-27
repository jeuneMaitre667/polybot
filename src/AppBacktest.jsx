import { BitcoinUpDownStrategy } from './components/BitcoinUpDownStrategy';

/**
 * UI minimale : uniquement la stratégie / backtest 15m.
 * Servie par `npm run dev:backtest` (port 5174) pour ne pas mélanger avec le dashboard principal.
 */
export default function AppBacktest() {
  return (
    <div className="layout app-root">
      <header className="pm-header">
        <div className="logo">
          <div className="logo-mark">PM</div>
          <div>
            <div className="logo-text">Backtest 15m</div>
            <div className="logo-sub">Instance locale dédiée</div>
          </div>
        </div>
      </header>

      <main className="app-main app-main--flat">
        <div className="app-stack app-stack--tight" style={{ paddingTop: 12 }}>
          <p
            className="strat-data-window__body strat-muted-tight"
            style={{ margin: '0 0 8px 0', maxWidth: 900 }}
          >
            Serveur Vite séparé du dashboard principal : les appels Polymarket (Gamma, CLOB, Data API)
            partent de ce navigateur. Ouvre le dashboard habituel sur le port par défaut si tu veux
            suivre le bot en parallèle.
          </p>
          <div className="app-strat-full">
            <BitcoinUpDownStrategy />
          </div>
        </div>
      </main>
    </div>
  );
}
