import { CompoundInterestCalculator } from './components/CompoundInterestCalculator';
import { BitcoinUpDownStrategy } from './components/BitcoinUpDownStrategy';
import { BotStatusBadge } from './components/BotStatus';
import { TradeHistory } from './components/TradeHistory';

export default function App() {
  return (
    <div className="min-h-screen text-slate-200">
      <header className="border-b border-slate-700/50 bg-slate-900/50 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">
            <span className="text-emerald-400">Polymarket</span>
            <span className="text-slate-300"> — Bot</span>
          </h1>
          <nav className="flex items-center gap-3">
            <span className="rounded-lg bg-emerald-500/20 px-3 py-2 text-sm font-medium text-emerald-400">
              Bot
            </span>
            <BotStatusBadge />
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="space-y-8">
          <BitcoinUpDownStrategy />
          <TradeHistory />
          <CompoundInterestCalculator />
        </div>
      </main>
    </div>
  );
}
