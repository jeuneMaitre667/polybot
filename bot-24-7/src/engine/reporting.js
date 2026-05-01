import { CONFIG, STATE } from './config.js';
import { getUnifiedMarketState } from './strategy.js';
import { fetchSignals } from '../../signal-engine.js';
import { gotScraping } from 'got-scraping';
import { getStealthProfile } from '../../stealth-config.js';
import { getVirtualBalance } from '../../src/core/virtual-wallet.js';
import { timeKeeper } from '../../src/core/ntp-client.js';
import * as RiskManager from '../../risk-manager.js';
import { ethers } from 'ethers';

const slotStrikeLock = new Map();
let lastBalanceFetchTime = 0;

export async function reportingLoop() {
    if (STATE.isReporting) {
        setTimeout(reportingLoop, 1000);
        return;
    }

    STATE.isReporting = true;
    try {
        const now = timeKeeper.getNow();
        const slotStart = Math.floor(now / 300000) * 300000;
        const secondsLeft = Math.floor((slotStart + 300000 - now) / 1000);
        
        // 0. Fetch Real Blockchain Balance
        if (now - lastBalanceFetchTime > CONFIG.BALANCE_REFRESH_MS || STATE.userBalance === null) {
            try {
                const provider = new ethers.providers.StaticJsonRpcProvider(CONFIG.PRIMARY_RPC, 137);
                const funder = process.env.CLOB_FUNDER_ADDRESS;
                const pusd = new ethers.Contract(CONFIG.PUSD_ADDRESS, ["function balanceOf(address owner) view returns (uint256)"], provider);
                const pusdRaw = await pusd.balanceOf(funder);
                const pusdBalance = parseFloat(ethers.utils.formatUnits(pusdRaw, 6));

                STATE.userBalance = CONFIG.IS_SIMULATION_ENABLED ? getVirtualBalance() : pusdBalance;
                lastBalanceFetchTime = now;

                if (!STATE.riskSessionInitialized && STATE.userBalance !== null) {
                    RiskManager.initSession(STATE.userBalance);
                    STATE.riskSessionInitialized = true;
                }
            } catch (err) {}
        }

        // 1. Market State
        const marketState = await getUnifiedMarketState('BTC', slotStrikeLock);
        const { bSpot, effectiveStrike, bDeltaPct } = marketState;

        // 2. HUD & Signals
        const signalData = await fetchSignals('BTC').catch(() => ({ signals: [] }));
        const currentSlotSec = Math.floor(slotStart / 1000);
        const sig = signalData.signals.find(s => s.slug && s.slug.endsWith(String(currentSlotSec)));

        if (sig) {
            let bestAskUp = sig.priceYes || 0.5;
            let bestAskDown = sig.priceNo || 0.5;

            const stealthOpts = getStealthProfile();
            if (process.env.PROXY_URL) stealthOpts.proxyUrl = process.env.PROXY_URL;

            // Optional Book Refresh for HUD accuracy
            if (sig.tokenIdYes && (now % 5000 < 1000)) {
                const res = await gotScraping.get(`https://clob.polymarket.com/book?token_id=${sig.tokenIdYes}`, { ...stealthOpts, retry: { limit: 1 } }).catch(() => null);
                if (res) {
                    const asks = res.body?.asks || [];
                    if (asks.length > 0) bestAskUp = Math.min(...asks.map(a => parseFloat(a.price)).filter(p => p < 0.999));
                }
            }
            if (sig.tokenIdNo && (now % 5000 < 1000)) {
                const res = await gotScraping.get(`https://clob.polymarket.com/book?token_id=${sig.tokenIdNo}`, { ...stealthOpts, retry: { limit: 1 } }).catch(() => null);
                if (res) {
                    const asks = res.body?.asks || [];
                    if (asks.length > 0) bestAskDown = Math.min(...asks.map(a => parseFloat(a.price)).filter(p => p < 0.999));
                }
            }

            const currentSlotLabel = sig.slug ? sig.slug.split('-').pop() : '000';
            const deltaUsd = bSpot - effectiveStrike;
            const deltaPct = effectiveStrike > 0 ? (deltaUsd / effectiveStrike) * 100 : 0;
            const deltaSign = deltaUsd >= 0 ? '+' : '';
            
            const isDeltaMet = Math.abs(deltaPct) >= CONFIG.SNIPER_DELTA_THRESHOLD_PCT;
            const upLabel = '🛡️🛰️⚓ UP';
            const downLabel = '🛡️🛰️⚓ DOWN';

            const displayBalance = CONFIG.IS_SIMULATION_ENABLED ? getVirtualBalance() : STATE.userBalance;
            const pipelineLine = `[PIPELINE] | T-${secondsLeft}s | slot:${currentSlotLabel} | ${upLabel}:${(bestAskUp * 100).toFixed(1)}% | ${downLabel}:${(bestAskDown * 100).toFixed(1)}% | Bal:$${(displayBalance||0).toFixed(2)} | Open:${(effectiveStrike||0).toFixed(2)} | Spot:${bSpot.toFixed(2)} | Δ:${deltaSign}$${deltaUsd.toFixed(2)} (${deltaSign}${deltaPct.toFixed(3)}%)`;
            
            console.log(pipelineLine);

            // --- 🛡️🛰️⚓ HEARTBEAT STATUS TELEGRAM ---
            if (secondsLeft <= 90 && secondsLeft >= 10 && STATE.lastHeartbeatSlot !== slotStart) {
                STATE.lastHeartbeatSlot = slotStart;
                const displayTime = new Date(now).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
                let engineStatus = (STATE.userBalance === null && !CONFIG.IS_SIMULATION_ENABLED) ? "SYNCING... ⏳" : "READY 🛡️🛰️⚓";
                
                const hbMsg = `🛡️🛰️⚓ *SNIPER STATUS : ${displayTime}* 🛡️🛰️⚓\n\n` +
                              `• Window: OPEN 🛡️🛰️⚓\n` +
                              `• Capital: $${(STATE.userBalance || 0).toFixed(2)} 🛡️🛰️⚓\n` +
                              `• Engine: ${engineStatus}\n\n` +
                              `\`${pipelineLine}\``;

                const token = (process.env.ALERT_TELEGRAM_BOT_TOKEN || '').trim();
                const chatId = (process.env.ALERT_TELEGRAM_CHAT_ID || '').trim();
                const url = `https://api.telegram.org/bot${token}/sendMessage`;

                import('axios').then(axios => {
                    axios.default.post(url, { chat_id: chatId, text: hbMsg, parse_mode: 'Markdown', disable_web_page_preview: true }, { timeout: 10000 })
                        .then(() => console.log(`[Heartbeat] 🛡️🛰️⚓ Telegram Status Sent.`))
                        .catch(e => console.error(`[Heartbeat] Telegram Error:`, e.message));
                });
            }
        }
    } catch (err) {
        console.error("[Reporting] Loop Error:", err.message);
    } finally {
        STATE.isReporting = false;
        setTimeout(reportingLoop, 1000);
    }
}
