import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      buffer: 'buffer',
    },
  },
  optimizeDeps: {
    include: ['buffer', '@polymarket/clob-client'],
  },
  server: {
    proxy: {
      '/api/': {
        target: 'https://gamma-api.polymarket.com',
        changeOrigin: true,
        rewrite: (path) => String(path).replace(/^\/api\//, ''),
      },
      '/apiClob': {
        target: 'https://clob.polymarket.com',
        changeOrigin: true,
        rewrite: (path) => String(path).replace(/^\/apiClob/, '').replace(/^apiClob/, ''),
      },
      // Certains navigateurs / extensions normalisent la casse → 404 sans proxy.
      '/apiclob': {
        target: 'https://clob.polymarket.com',
        changeOrigin: true,
        rewrite: (path) => String(path).replace(/^\/apiclob/i, ''),
      },
      '/apiData': {
        target: 'https://data-api.polymarket.com',
        changeOrigin: true,
        rewrite: (path) => String(path).replace(/^\/apiData/, '').replace(/^apiData/, ''),
      },
    },
  },
})
