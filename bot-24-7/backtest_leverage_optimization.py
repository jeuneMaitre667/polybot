import pandas as pd

df = pd.read_csv('btc_5m_history.csv')

def backtest_leverage(leverage):
    MARGIN = 10
    DELTA_THRESHOLD = 0.0010 
    SL_FACTOR = 0.001
    TP_FACTOR = 0.005
    
    trades = []
    for i in range(len(df)-1):
        row = df.iloc[i]; next_row = df.iloc[i+1]
        strike = row['Open']; entry = next_row['Open']
        delta_pct = abs(entry - strike) / strike
        
        if delta_pct >= DELTA_THRESHOLD:
            direction = 'LONG' if entry > strike else 'SHORT'
            sl_price = entry * (1-SL_FACTOR) if direction == 'LONG' else entry * (1+SL_FACTOR)
            tp_price = entry * (1+TP_FACTOR) if direction == 'LONG' else entry * (1-TP_FACTOR)
            
            # Checks
            sl_hit = (next_row['Low'] <= sl_price if direction == 'LONG' else next_row['High'] >= sl_price)
            tp_hit = (next_row['High'] >= tp_price if direction == 'LONG' else next_row['Low'] <= tp_price)
            
            if sl_hit:
                exit_price = sl_price
            elif tp_hit:
                exit_price = tp_price
            else:
                exit_price = next_row['Close']
            
            pnl_pct = (exit_price - entry) / entry * leverage if direction == 'LONG' else (entry - exit_price) / entry * leverage
            trades.append(pnl_pct * MARGIN)
    
    total_pnl = sum(trades)
    winrate = (pd.Series(trades) > 0).mean() * 100
    return total_pnl, winrate

print(f"{'Levier':<10} | {'PnL Total':<12} | {'Winrate':<10} | {'Rendement/Cap':<15}")
print("-" * 55)
for lev in [3, 10, 20, 50]:
    pnl, wr = backtest_leverage(lev)
    print(f"x{lev:<9} | ${pnl:<11.2f} | {wr:<9.1f}% | {pnl/10*100:<+14.1f}%")
