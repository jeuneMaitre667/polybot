import pandas as pd
import json
import os

# 1. MERGE DATA
steps_base = "C:/Users/cedpa/.gemini/antigravity/brain/4d35ca3b-42e8-46fc-b4ab-013539c4d333/.system_generated/steps/"
file1 = steps_base + "16825/content.md"
file2 = steps_base + "16832/content.md"

def load_klines(path):
    with open(path, 'r') as f:
        content = f.read()
        # Find the start of the JSON array
        json_str = content[content.find('[[') : content.rfind(']]')+2]
        return json.loads(json_str)

data1 = load_klines(file1)
data2 = load_klines(file2)
# data2 is older (endTime used), so data2 + data1
full_data = data2 + data1

df = pd.DataFrame(full_data, columns=['Timestamp', 'Open', 'High', 'Low', 'Close', 'Volume', 'CloseTime', 'AssetVol', 'Trades', 'BuyVol', 'BuyAssetVol', 'Ignore'])
df['Timestamp'] = pd.to_datetime(df['Timestamp'], unit='ms')
df[['Open', 'High', 'Low', 'Close']] = df[['Open', 'High', 'Low', 'Close']].apply(pd.to_numeric)
df.to_csv('btc_5m_history_week.csv', index=False)

# 2. BACKTEST WITH STREAK ANALYSIS
def backtest_mega():
    MARGIN = 100
    LEVERAGE = 100
    DELTA_THRESHOLD = 0.0010 
    SL_FACTOR = 0.001
    
    balance = MARGIN
    history = []
    
    current_win_streak = 0
    current_loss_streak = 0
    max_win_streak = 0
    max_loss_streak = 0
    
    for i in range(len(df)-1):
        strike = df.iloc[i]['Open']
        entry = df.iloc[i+1]['Open']
        delta_pct = abs(entry - strike) / strike
        
        if delta_pct >= DELTA_THRESHOLD:
            direction = 'LONG' if entry > strike else 'SHORT'
            sl_price = entry * (1-SL_FACTOR) if direction == 'LONG' else entry * (1+SL_FACTOR)
            sl_hit = (df.iloc[i+1]['Low'] <= sl_price if direction == 'LONG' else df.iloc[i+1]['High'] >= sl_price)
            
            exit_price = sl_price if sl_hit else df.iloc[i+1]['Close']
            
            pnl_pct = (exit_price - entry) / entry * LEVERAGE if direction == 'LONG' else (entry - exit_price) / entry * LEVERAGE
            pnl_usd = pnl_pct * MARGIN # On base le PnL sur la marge initiale pour voir la croissance relative
            
            balance += pnl_usd
            
            is_win = pnl_usd > 0
            if is_win:
                current_win_streak += 1
                current_loss_streak = 0
                max_win_streak = max(max_win_streak, current_win_streak)
            else:
                current_loss_streak += 1
                current_win_streak = 0
                max_loss_streak = max(max_loss_streak, current_loss_streak)
            
            history.append({
                'time': df.iloc[i]['Timestamp'],
                'pnl': pnl_usd,
                'balance': balance,
                'is_win': is_win
            })
            
            if balance <= 0:
                return pd.DataFrame(history), max_win_streak, max_loss_streak, True

    return pd.DataFrame(history), max_win_streak, max_loss_streak, False

results, max_w, max_l, liquidated = backtest_mega()

print(f"🎯 RÉSULTATS MÉGA AUDIT (1 SEMAINE, $100, x100)")
print(f"Période: {df['Timestamp'].min()} au {df['Timestamp'].max()}")
print(f"Trades totaux: {len(results)}")
print(f"Winrate: {(results.is_win.mean()*100):.1f}%")
print(f"PnL Final: ${results.pnl.sum():+.2f}")
print(f"Balance Finale: ${results.iloc[-1]['balance'] if not results.empty else 100:.2f}")

print(f"\n🔥 ANALYSE DES SÉRIES")
print(f"Plus longue série de VICTOIRES: {max_w} trades d'affilée")
print(f"Plus longue série de DÉFAITES:  {max_l} trades d'affilée")

if liquidated:
    print("\n⚠️ ALERTE : COMPTE LIQUIDÉ (Balance tombée à 0 pendant la semaine)")
else:
    print("\n✅ SURVIE : Le compte a tenu toute la semaine !")
