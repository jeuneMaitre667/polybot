import pandas as pd
from datetime import timedelta

df = pd.read_csv('btc_5m_history.csv')
df['datetime'] = pd.to_datetime(df['Timestamp'])
df['local_time'] = df['datetime'] + timedelta(hours=2)

def backtest_final_boss():
    MARGIN = 50
    LEVERAGE = 100
    DELTA_THRESHOLD = 0.0010 
    SL_FACTOR = 0.001
    
    trades = []
    for i in range(len(df)-1):
        row = df.iloc[i]; next_row = df.iloc[i+1]
        strike = row['Open']; entry = next_row['Open']
        delta_pct = abs(entry - strike) / strike
        
        if delta_pct >= DELTA_THRESHOLD:
            direction = 'LONG' if entry > strike else 'SHORT'
            sl_price = entry * (1-SL_FACTOR) if direction == 'LONG' else entry * (1+SL_FACTOR)
            
            # Checks
            sl_hit = (next_row['Low'] <= sl_price if direction == 'LONG' else next_row['High'] >= sl_price)
            
            if sl_hit:
                exit_price = sl_price
            else:
                exit_price = next_row['Close']
            
            pnl_pct = (exit_price - entry) / entry * LEVERAGE if direction == 'LONG' else (entry - exit_price) / entry * LEVERAGE
            pnl_usd = pnl_pct * MARGIN
            
            trades.append({
                'time_local': row['local_time'],
                'direction': direction,
                'pnl_usd': pnl_usd
            })
    
    return pd.DataFrame(trades)

results = backtest_final_boss()
print(f"🎯 RÉSULTATS FINAL BOSS ($50, x50, SL 0.1%, Exit Close)")
print(f"Trades: {len(results)} | Winrate: {(results.pnl_usd>0).mean()*100:.1f}%")
print(f"PnL Total: ${results.pnl_usd.sum():+.2f} | Rendement: {results.pnl_usd.sum()/50*100:+.1f}% capital")

print("\n📈 FOCUS 18h - 19h (LOCAL)")
focus = results[(results.time_local >= '2026-04-06 18:00:00') & (results.time_local <= '2026-04-06 19:00:00')]
if not focus.empty:
    print(focus[['time_local', 'direction', 'pnl_usd']].to_string(index=False))
    print(f"\nTotal PnL Fenêtre: ${focus.pnl_usd.sum():+.2f}")
