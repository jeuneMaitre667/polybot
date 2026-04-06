import pandas as pd
from datetime import timedelta

df = pd.read_csv('btc_5m_history.csv')

def backtest_tp(tp_factor):
    MARGIN = 10
    LEVERAGE = 3
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
            tp_price = entry * (1+tp_factor) if direction == 'LONG' else entry * (1-tp_factor) if tp_factor else 0
            
            # Checks
            sl_hit = (next_row['Low'] <= sl_price if direction == 'LONG' else next_row['High'] >= sl_price)
            tp_hit = (next_row['High'] >= tp_price if direction == 'LONG' else next_row['Low'] <= tp_price) if tp_factor else False
            
            if sl_hit:
                # Priority to SL if both hit (Conservative)
                exit_price = sl_price
            elif tp_hit:
                exit_price = tp_price
            else:
                exit_price = next_row['Close']
            
            pnl = (exit_price - entry) / entry * LEVERAGE * MARGIN if direction == 'LONG' else (entry - exit_price) / entry * LEVERAGE * MARGIN
            trades.append(pnl)
    
    return sum(trades), (pd.Series(trades) > 0).mean() * 100

print("🔍 COMPARATIF TAKE PROFIT (Levier x3, SL 0.1%)")
for tp in [0, 0.0015, 0.0025, 0.005]:
    pnl, wr = backtest_tp(tp)
    label = f"TP {tp*100:.2f}%" if tp > 0 else "Sortie Close"
    print(f"{label:12} | PnL Total: ${pnl:+6.2f} | Winrate: {wr:.1f}%")
