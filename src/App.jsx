import { CompoundInterestCalculator } from './components/CompoundInterestCalculator';
import { BitcoinUpDownStrategy } from './components/BitcoinUpDownStrategy';
import { BotStatusBadge, BotBalanceChart } from './components/BotStatus';
import { TradeHistory } from './components/TradeHistory';
import { BotOverview } from './components/BotOverview';

export default function App() {
  return (
    <div className="min-h-screen text-slate-200">
      <header className="border-b border-slate-800/50 bg-slate-950/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
                <span className="text-emerald-400">Polymarket</span>
                <span className="text-slate-400 font-medium">Bot 24/7</span>
              </h1>
              <span className="rounded-md bg-slate-800/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-400 border border-slate-700/60">
                Temps réel
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Bitcoin Up or Down — automatisé, relié à ton wallet
            </p>
          </div>
          <nav className="shrink-0">
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
