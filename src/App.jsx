import { CompoundInterestCalculator } from './components/CompoundInterestCalculator';
import { BitcoinUpDownStrategy } from './components/BitcoinUpDownStrategy';
import { BotStatusBadge, BotBalanceChart } from './components/BotStatus';
import { TradeHistory } from './components/TradeHistory';
import { BotOverview } from './components/BotOverview';

export default function App() {
  return (
    <div className="min-h-screen text-slate-200">
      <header className="border-b border-slate-800/60 bg-slate-950/60 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
              <span className="text-emerald-400">Polymarket</span>
              <span className="text-slate-300"> — Bot 24/7</span>
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              Stratégie Bitcoin Up or Down automatisée, reliée à ton wallet.
            </p>
          </div>
          <nav className="flex items-center gap-3">
            <span className="rounded-full bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-300 border border-emerald-500/30 shadow-sm">
              Dashboard temps réel
            </span>
            <BotStatusBadge />
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="space-y-10">
          <BotOverview />

          <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)] items-start">
            <div className="space-y-8">
              <BotBalanceChart />
              <BitcoinUpDownStrategy />
            </div>
            <div className="space-y-8">
              <TradeHistory />
              <CompoundInterestCalculator />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
