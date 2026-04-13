import pandas as pd
from datetime import timedelta

# LOAD DATA
df = pd.read_csv('btc_5m_history.csv')
df['datetime'] = pd.to_datetime(df['Timestamp'])
df['local_time'] = df['datetime'] + timedelta(hours=2)

# PARAMETERS
MARGIN = 10
LEVERAGE = 3
DELTA_THRESHOLD = 0.0010 
SL_FACTOR = 0.001

audit_data = []

# GENERATE AUDIT FOR EVERY CANDLE
for i in range(len(df)-1):
    row = df.iloc[i]
    next_row = df.iloc[i+1]
    
    strike = row['Open']
    entry = next_row['Open']
    delta_pct = abs(entry - strike) / strike
    
    action = "NONE"
    entry_price = 0
    exit_price = 0
    pnl = 0
    
    if delta_pct >= DELTA_THRESHOLD:
        action = "LONG" if entry > strike else "SHORT"
        entry_price = entry
        
        # Stop Loss Check
        sl_price = entry * (1 - SL_FACTOR) if action == "LONG" else entry * (1 + SL_FACTOR)
        sl_hit = (next_row['Low'] <= sl_price if action == "LONG" else next_row['High'] >= sl_price)
        
        exit_price = sl_price if sl_hit else next_row['Close']
        
        if action == "LONG":
            pnl = (exit_price - entry_price) / entry_price * LEVERAGE * MARGIN
        else:
            pnl = (entry_price - exit_price) / entry_price * LEVERAGE * MARGIN

    audit_data.append({
        'Time_Local': row['local_time'].strftime('%H:%M'),
        'Open': round(strike, 1),
        'High': round(row['High'], 1),
        'Low': round(row['Low'], 1),
        'Close': round(row['Close'], 1),
        'Delta_%': round(delta_pct * 100, 3),
        'Action': action,
        'Entry': round(entry_price, 1) if entry_price > 0 else "-",
        'Exit': round(exit_price, 1) if exit_price > 0 else "-",
        'PnL_USD': round(pnl, 4) if pnl != 0 else "-"
    })

# SAVE AND EXPORT
audit_df = pd.DataFrame(audit_data)
audit_df.to_csv('full_strategy_audit.csv', index=False)
print(audit_df.tail(25).iloc[::-1].to_string(index=False))
