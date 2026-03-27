import './polyfills.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import AppBacktest from './AppBacktest.jsx';
import { WalletProvider } from './context/WalletContext.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <WalletProvider>
        <AppBacktest />
      </WalletProvider>
    </ErrorBoundary>
  </StrictMode>
);
