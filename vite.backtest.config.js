import { mergeConfig } from 'vite';
import baseConfig from './vite.config.js';

/** Sur ce serveur, la racine sert uniquement le backtest (évite d’ouvrir le dashboard par erreur). */
function backtestRootIndexPlugin() {
  return {
    name: 'backtest-root-index',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const raw = req.url || '';
        const q = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';
        const pathOnly = raw.split('?')[0] || '';
        if (pathOnly === '/' || pathOnly === '/index.html') {
          req.url = `/index.backtest.html${q}`;
        }
        next();
      });
    },
  };
}

/** Dev server dédié backtest (port distinct). */
export default mergeConfig(baseConfig, {
  plugins: [backtestRootIndexPlugin()],
  server: {
    port: 5174,
    strictPort: false,
    open: true,
  },
});
