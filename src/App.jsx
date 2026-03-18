import { BitcoinUpDownStrategy } from './components/BitcoinUpDownStrategy';
import { BotStatusBadge } from './components/BotStatus';
import { DEFAULT_BOT_STATUS_URL_15M } from './hooks/useBotStatus.js';
import { TradeHistory } from './components/TradeHistory';
import { BotOverview } from './components/BotOverview';

export default function App() {
  return (
    <div className="min-h-screen text-slate-200">
      <header className="border-b border-slate-800/50 bg-slate-950/80 backdrop-blur-xl overflow-hidden">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <nav className="w-full">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-stretch sm:justify-items-end">
              <BotStatusBadge label="Bot 1h" />
              {DEFAULT_BOT_STATUS_URL_15M && <BotStatusBadge statusUrl={DEFAULT_BOT_STATUS_URL_15M} label="Bot 15m" />}
            </div>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pt-16 pb-8 sm:px-6 lg:px-8">
        <div className="space-y-10">
          <BotOverview />

          <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)] items-start">
            <div className="space-y-8">
              <BitcoinUpDownStrategy />
            </div>
            <div className="space-y-8">
              <TradeHistory />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
