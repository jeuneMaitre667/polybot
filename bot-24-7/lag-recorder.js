import fs from 'fs';
import path from 'path';

class LagRecorder {
    constructor() {
        this.logFile = path.join(process.cwd(), 'lag_observations.jsonl');
        this.states = new Map(); // asset -> { perpPrice, chainlinkPrice, polyUpPrice, polyDownPrice, ts, history }
    }

    /**
     * Récupère ou initialise l'état pour un actif donné.
     */
    _getState(asset) {
        if (!this.states.has(asset)) {
            this.states.set(asset, {
                perpPrice: null,
                chainlinkPrice: null,
                polyUpPrice: null,
                polyDownPrice: null,
                ts: {
                    perp:      null,
                    chainlink: null,
                    poly:      null,
                },
                perpHistory:    [],
                chainlinkHistory: [],
                polyHistory:    []
            });
        }
        return this.states.get(asset);
    }

    /** Appelé par le WebSocket Binance Perp (aggTrade) */
    onPerpUpdate(asset, price) {
        if (!price || isNaN(price)) return;
        const state = this._getState(asset);
        const prev = state.perpPrice;
        state.perpPrice = price;
        state.ts.perp = Date.now() / 1000;
        
        state.perpHistory.push({ ts: state.ts.perp, price });
        if (state.perpHistory.length > 10) state.perpHistory.shift();
        
        if (prev && this._directionChanged(state.perpHistory)) {
            this._onSignalDetected(asset, "PERP", prev, price);
        }
    }

    /** Appelé par le listener Chainlink (Alchemy) */
    onChainlinkUpdate(asset, price) {
        if (!price || isNaN(price)) return;
        const state = this._getState(asset);
        const prev = state.chainlinkPrice;
        state.chainlinkPrice = price;
        state.ts.chainlink = Date.now() / 1000;
        
        state.chainlinkHistory.push({ ts: state.ts.chainlink, price });
        if (state.chainlinkHistory.length > 10) state.chainlinkHistory.shift();
        
        if (prev && this._directionChanged(state.chainlinkHistory)) {
            this._onSignalDetected(asset, "CHAINLINK", prev, price);
        }
    }

    /** Appelé par le WebSocket Polymarket (CLOB) */
    onPolyUpdate(asset, upPrice, downPrice) {
        if (!upPrice || isNaN(upPrice)) return;
        const state = this._getState(asset);
        const prevUp = state.polyUpPrice;
        state.polyUpPrice   = upPrice;
        state.polyDownPrice = downPrice;
        state.ts.poly = Date.now() / 1000;
        
        state.polyHistory.push({ ts: state.ts.poly, price: upPrice });
        if (state.polyHistory.length > 10) state.polyHistory.shift();
        
        if (prevUp && this._directionChanged(state.polyHistory)) {
            this._onSignalDetected(asset, "POLY", prevUp, upPrice);
        }
    }

    /** Détection de changement de sens (basé sur les 3 derniers points) */
    _directionChanged(history) {
        if (history.length < 3) return false;
        
        const last3 = history.slice(-3);
        const p3 = last3[2].price;
        const p2 = last3[1].price;
        const p1 = last3[0].price;
        
        const d1 = p3 - p2; // Dernier move
        const d2 = p2 - p1; // Précédent move
        
        // Changement si les signes des variations sont opposés
        return (d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0);
    }

    /** Log l'événement asymétriquement dans le JSONL */
    _onSignalDetected(asset, source, prev, curr) {
        const now = Date.now() / 1000;
        const state = this._getState(asset);
        
        const record = {
            asset,
            detected_by:       source,
            detected_at:       now,
            detected_at_iso:   new Date().toISOString(),
            
            // Prix au moment de la détection
            perp_price:        state.perpPrice,
            chainlink_price:   state.chainlinkPrice,
            poly_up:           state.polyUpPrice,
            poly_down:         state.polyDownPrice,
            
            // Timestamps (secondes)
            perp_last_update:      state.ts.perp,
            chainlink_last_update: state.ts.chainlink,
            poly_last_update:      state.ts.poly,
            
            // Lags calculés (en secondes)
            lag_chainlink_vs_perp:  (state.ts.chainlink && state.ts.perp) ? (state.ts.chainlink - state.ts.perp) : null,
            lag_poly_vs_chainlink: (state.ts.poly && state.ts.chainlink) ? (state.ts.poly - state.ts.chainlink) : null,
            lag_poly_vs_perp:      (state.ts.poly && state.ts.perp)      ? (state.ts.poly - state.ts.perp)      : null,
            
            // Amplitude & Direction
            move_pct:  Number(((curr - prev) / prev * 100).toFixed(4)),
            direction: curr > prev ? "UP" : "DOWN",
            
            // Contexte marché
            gap_at_detection: (state.polyUpPrice != null) ? Number((Math.abs(state.polyUpPrice - 0.5) * 2).toFixed(4)) : null,
            hour_utc: new Date().getUTCHours(),
            weekday:  new Date().getUTCDay(),
        };

        // Écriture non-bloquante
        const line = JSON.stringify(record) + '\n';
        fs.appendFile(this.logFile, line, (err) => {
            if (err) console.warn(`[LAG][${asset}] Erreur écriture JSONL:`, err.message);
        });

        // Throttling console feedback (v8.1.1 : Quiet mode)
        const lastLogTs = this._getState(asset).lastConsoleLogTs || 0;
        const nowMs = Date.now();
        const significantMove = Math.abs(record.move_pct) > 0.05;
        const timeoutReached = (nowMs - lastLogTs) > 120000; // 2 minutes

        if (significantMove || timeoutReached) {
            const lagTxt = record.lag_poly_vs_perp != null ? `${record.lag_poly_vs_perp.toFixed(3)}s` : 'N/A';
            console.log(`[LAG][${asset}] 🛰️ ${source} | window=${lagTxt} | move=${record.move_pct > 0 ? '+' : ''}${record.move_pct}% | poly_up=${state.polyUpPrice?.toFixed(3)}`);
            this._getState(asset).lastConsoleLogTs = nowMs;
        }
    }
}

export default new LagRecorder();
