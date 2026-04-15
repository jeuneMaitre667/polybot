import pandas as pd
import numpy as np

def calculate_stats(csv_path):
    try:
        df = pd.read_csv(csv_path)
        
        # Filter rows with trades (LONG or SHORT)
        trades = df[df['Action'].isin(['LONG', 'SHORT'])].copy()
        
        # Clean PnL column: convert to numeric, replace '-' with NaN
        trades['PnL_USD'] = pd.to_numeric(trades['PnL_USD'], errors='coerce')
        trades = trades.dropna(subset=['PnL_USD'])
        
        total_trades = len(trades)
        if total_trades == 0:
            return "No trades found in CSV."

        wins = trades[trades['PnL_USD'] > 0]
        losses = trades[trades['PnL_USD'] < 0] # strictly negative for losses
        neutral = trades[trades['PnL_USD'] == 0]

        total_wins = len(wins)
        total_losses = len(losses)
        
        avg_win = wins['PnL_USD'].mean() if total_wins > 0 else 0
        avg_loss = losses['PnL_USD'].mean() if total_losses > 0 else 0
        
        # Win Rate
        win_rate = (total_wins / total_trades) * 100
        
        # PnL Calculation
        # Assuming PnL_USD is fractional (e.g. 0.05 is 5%)
        # total_return_pct = trades['PnL_USD'].sum() * 100
        
        # Compound Equity
        equity = (1 + trades['PnL_USD']).cumprod()
        final_return = (equity.iloc[-1] - 1) * 100 if not equity.empty else 0
        
        # Drawdown
        max_equity = equity.cummax()
        drawdown = (equity - max_equity) / max_equity
        max_drawdown = drawdown.min() * 100
        
        # Profit Factor
        gross_profit = wins['PnL_USD'].sum()
        gross_loss = abs(losses['PnL_USD'].sum())
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else float('inf')

        return {
            "Total Trades": total_trades,
            "Wins": total_wins,
            "Losses": total_losses,
            "Neutral": len(neutral),
            "Win Rate": f"{win_rate:.2f}%",
            "ROI (Session)": f"{final_return:.2f}%",
            "Avg Win": f"{avg_win*100:.2f}%",
            "Avg Loss": f"{avg_loss*100:.2f}%",
            "Profit Factor": f"{profit_factor:.2f}",
            "Max Drawdown": f"{max_drawdown:.2f}%"
        }
    except Exception as e:
        return f"Error: {str(e)}"

# Current State from Wallet
start_bal = 100.00
current_bal = 137.42
total_gain = current_bal - start_bal
total_roi = (total_gain / start_bal) * 100

print(f"--- Global Performance (Session Overview) ---")
print(f"Start Balance: ${start_bal:.2f}")
print(f"Current Balance: ${current_bal:.2f}")
print(f"Net Profit: +${total_gain:.2f}")
print(f"Total ROI: +{total_roi:.2f}%")
print(f"\n--- Strategy Audit Details ---")
print(calculate_stats('c:/Users/cedpa/polymarket-dashboard/bot-24-7/full_strategy_audit.csv'))
