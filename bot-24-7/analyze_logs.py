import json
import os
import statistics
from datetime import datetime

# Chemins des fichiers (ajuster si besoin localement)
DECISIONS_LOG = "decisions.log"
LAG_LOG = "lag_observations.jsonl"
BOT_LOG = "bot.log"

def analyze():
    print("=== 📊 RAPPORT D'ANALYSE ARBITRAGE ENGINE v5.2.4 ===")
    
    # 1. Analyse decisions.log
    total_cycles = 0
    stale_count = 0
    buy_up_count = 0
    buy_down_count = 0
    wait_count = 0
    suspicious_count = 0
    vol_buckets = {"low": 0, "mid": 0, "high": 0}
    
    if os.path.exists(DECISIONS_LOG):
        with open(DECISIONS_LOG, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    data = json.loads(line)
                    total_cycles += 1
                    
                    if data.get("chainlink_status") == "stale":
                        stale_count += 1
                    
                    decision = data.get("decision")
                    if decision == "BUY_UP": buy_up_count += 1
                    elif decision == "BUY_DOWN": buy_down_count += 1
                    elif decision == "WAIT": wait_count += 1
                    
                    if data.get("volBucket"):
                        bucket = data["volBucket"]
                        vol_buckets[bucket] = vol_buckets.get(bucket, 0) + 1
                    
                    # Note: Si on logue explicitement 'SUSPICIOUS' dans une version future
                    if '"SUSPICIOUS"' in line: suspicious_count += 1
                        
                except: continue

    # 2. Analyse lag_observations.jsonl
    lags = []
    if os.path.exists(LAG_LOG):
        with open(LAG_LOG, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    data = json.loads(line)
                    val = data.get("lag_poly_vs_perp")
                    if val is not None:
                        lags.append(abs(val))
                except: continue

    # 3. Analyse bot.log (Benchmark)
    benchmark_baseline = {"Up": 0, "Down": 0}
    if os.path.exists(BOT_LOG):
        with open(BOT_LOG, "r", encoding="utf-8") as f:
            for line in f:
                if "benchmark_baseline" in line:
                    try:
                        data = json.loads(line)
                        meta = data.get("meta") or data # Depend de la version de logJson
                        choice = data.get("random_choice") or (data.get("meta") and data["meta"].get("random_choice"))
                        if choice: benchmark_baseline[choice] += 1
                    except: continue

    # RECAPITULATIF
    print(f"\n--- 📈 VOLUME & DISPONIBILITÉ ---")
    print(f"1. Cycles totaux       : {total_cycles}")
    if total_cycles > 0:
        stale_pct = (stale_count / total_cycles) * 100
        print(f"2. Skip Stale (8s)     : {stale_count} ({stale_pct:.2f}%)")
    
    print(f"\n--- 🛰️ LATENCE (LAG) ---")
    if lags:
        print(f"3. Lag Poly vs Perp    :")
        print(f"   Max                 : {max(lags):.3f}s")
        print(f"   Moyenne             : {statistics.mean(lags):.3f}s")
        print(f"   Min                 : {min(lags):.3f}s")
    else:
        print("3. Lag Poly vs Perp    : Aucune donnée capturée")

    print(f"\n--- 🧠 MODÈLE & DÉCISIONS ---")
    print(f"4. GAPs détectés       : {buy_up_count + buy_down_count} (UP: {buy_up_count}, DOWN: {buy_down_count})")
    print(f"5. Sizing Buckets      : Low: {vol_buckets.get('low',0)}, Mid: {vol_buckets.get('mid',0)}, High: {vol_buckets.get('high',0)}")
    print(f"6. Adverse Selection   : {suspicious_count} bloqués (estimation)")

    print(f"\n--- 🏆 BENCHMARK PASSIF ---")
    print(f"7. Paris Aléatoires    : UP: {benchmark_baseline['Up']}, DOWN: {benchmark_baseline['Down']}")
    
    print("\n================================================")

if __name__ == "__main__":
    analyze()
