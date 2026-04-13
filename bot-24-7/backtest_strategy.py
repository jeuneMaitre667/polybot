import pandas as pd
from datetime import datetime, timedelta

# LOAD DATA
df = pd.read_csv('btc_5m_history.csv')
df['datetime'] = pd.to_datetime(df['Timestamp'])
df.set_index('datetime', inplace=True)

# PARAMETERS
MARGIN = 10
LEVERAGE = 3
DELTA_THRESHOLD = 0.0010  # 0.10%

trades = []

# BACKTEST (Local Time Window is 18h-19h -> UTC 16h-17h)
for i in range(len(df)-1):
    strike = df.iloc[i]['Open']
    entry = df.iloc[i+1]['Open']
    
    delta_pct = abs(entry - strike) / strike
    
    if delta_pct >= DELTA_THRESHOLD:
        direction = 'LONG' if entry > strike else 'SHORT'
        # SL 0.1%
        sl_price = entry * 0.999 if direction == 'LONG' else entry * 1.001
        
        # Check SL in candle i+1
        sl_hit = (df.iloc[i+1]['Low'] <= sl_price if direction == 'LONG' else df.iloc[i+1]['High'] >= sl_price)
        
        # Determine Exit Price
        if sl_hit:
            exit_price = sl_price
        else:
            exit_price = df.iloc[i+1]['Close']
            
        if direction == 'LONG':
            pnl_pct = (exit_price - entry) / entry * LEVERAGE
        else:
            pnl_pct = (entry - exit_price) / entry * LEVERAGE
            
        pnl_usd = pnl_pct * MARGIN
        
        trades.append({
            'time_utc': df.index[i],
            'time_local': df.index[i] + timedelta(hours=2),
            'strike': strike,
            'entry': entry,
            'delta_pct': delta_pct*100,
            'direction': direction,
            'pnl_usd': pnl_usd
        })

trades_df = pd.DataFrame(trades)

# SAVE ALL TRADES TO CSV
trades_df.to_csv('backtest_results_all.csv', index=False)
print(f"✅ Rapport complet généré : backtest_results_all.csv ({len(trades_df)} trades)")

# DISPLAY ALL TRADES
pd.set_option('display.max_rows', None)
print("\n📝 DÉTAIL DE TOUS LES TRADES :")
print(trades_df[['time_local', 'direction', 'delta_pct', 'pnl_usd']].to_string(index=False))
