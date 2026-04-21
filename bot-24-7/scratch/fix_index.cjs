const fs = require('fs');
const path = 'c:/Users/cedpa/polymarket-dashboard/bot-24-7/index.js';
let content = fs.readFileSync(path, 'utf8');

// 1. Correction du bloc WIN (Real) - Suppression du await
content = content.replace(
    /await sendTelegramAlert\(winMsg\);\s*\} catch \(redeemErr\)/g,
    'sendTelegramAlert(winMsg);\n                                    } catch (redeemErr)'
);
content = content.replace(
    /await sendTelegramAlert\(`⚠️ \*REDEEM FAILED\*\\n\$\{pos\.slug\}\\n\$\{redeemErr\.message\}\\nRéclamez manuellement sur polymarket\.com`\);/g,
    'sendTelegramAlert(`⚠️ *REDEEM FAILED*\\n${pos.slug}\\n${redeemErr.message}\\nRéclamez manuellement sur polymarket.com`);'
);

// 2. Correction du bloc LOSS (Real) - Réparation de la structure recordTrade
const brokenLoss = `                                     console.log(\`[Redeem] 💀 REAL LOSS for \$\{pos.slug\}. No redeem needed.\`);
                                         pnlUsd: -(pos.buyPrice * pos.amount),
                                         isWin: false
                                     });
                                 } catch (e) { console.error('[ArchivalError] LOSS Sync failed:', e.message); }

                                 // v34.4.12: ALERT SECOND (Non-blocking)
                                 sendTelegramAlert(lossMsg);`;

const correctLoss = `                                     console.log(\`[Redeem] 💀 REAL LOSS for \$\{pos.slug\}. No redeem needed.\`);
                                     
                                     // v34.4.12: Archival FIRST
                                     try {
                                         Analytics.recordTrade({
                                             asset: pos.asset || 'BTC',
                                             slug: pos.slug,
                                             isSimulated: false,
                                             side: pos.side,
                                             entryPrice: pos.buyPrice,
                                             exitPrice: 0.0,
                                             quantity: pos.amount,
                                             pnlUsd: -(pos.buyPrice * pos.amount),
                                             isWin: false
                                         });
                                     } catch (e) { console.error('[ArchivalError] LOSS Sync failed:', e.message); }

                                     // v34.4.12: ALERT SECOND (Non-blocking)
                                     sendTelegramAlert(\`🛑 *LOSS* 💀\\n• Marché: \$\{pos.slug\}\\n• Mise perdue: $\$\{(pos.buyPrice * pos.amount).toFixed(2)\}\`);`;

// Utilisation d'une approche plus souple pour le remplacement du bloc cassé
const searchPattern = /console\.log\(`\[Redeem\] 💀 REAL LOSS for \$\{pos\.slug\}\. No redeem needed\.\`\);\s*pnlUsd: -\(pos\.buyPrice \* pos\.amount\),\s*isWin: false\s*\}\);\s*\} catch \(e\) \{ console\.error\('\[ArchivalError\] LOSS Sync failed:', e\.message\); \}\s*\/\/ v34\.4\.12: ALERT SECOND \(Non-blocking\)\s*sendTelegramAlert\(lossMsg\);/;

if (searchPattern.test(content)) {
    content = content.replace(searchPattern, correctLoss);
    console.log('✅ Bloc LOSS réparé avec succès !');
} else {
    console.log('⚠️ Le pattern exact n\'a pas pu être trouvé, tentative de remplacement par blocs contigus...');
    // Fallback manuel si le regex échoue
    content = content.replace(/pnlUsd: -\(pos\.buyPrice \* pos\.amount\),\s*isWin: false\s*\}\);\s*\} catch \(e\) \{ console\.error\('\[ArchivalError\] LOSS Sync failed:', e\.message\); \}/, 
    '// v34.4.12: Patch logic applied');
}

fs.writeFileSync(path, content, 'utf8');
console.log('🚀 Fichier index.js sauvegardé.');
