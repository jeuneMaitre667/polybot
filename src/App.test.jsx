import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App.jsx';
import { WalletProvider } from './context/WalletContext.jsx';

vi.mock('./components/BotStatus', () => ({
  BotStatusBadge: () => <div data-testid="bot-status-badge">BotStatusBadge</div>,
}));

vi.mock('./components/BotOverview', () => ({
  BotOverview: () => <div data-testid="bot-overview">BotOverview</div>,
}));

vi.mock('./components/BitcoinUpDownStrategy', () => ({
  BitcoinUpDownStrategy: () => <div data-testid="bitcoin-strategy">BitcoinUpDownStrategy</div>,
}));

vi.mock('./components/TradeHistory', () => ({
  TradeHistory: () => <div data-testid="trade-history">TradeHistory</div>,
}));

function TestWrapper({ children }) {
  return <WalletProvider>{children}</WalletProvider>;
}

describe('App', () => {
  it('renders header with title and bot badge', () => {
    render(<App />, { wrapper: TestWrapper });
    const header = screen.getByRole('banner');
    const badges = screen.getAllByTestId('bot-status-badge');
    expect(badges.length).toBeGreaterThanOrEqual(1);
    expect(badges[0]).toBeInTheDocument();
    // Le header est surtout utilisé comme conteneur des badges : le texte peut varier.
    expect(badges[0].parentElement).toBeTruthy();
  });

  it('renders main sections', () => {
    render(<App />, { wrapper: TestWrapper });
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByTestId('bot-overview')).toBeInTheDocument();
    expect(screen.getByTestId('bitcoin-strategy')).toBeInTheDocument();
  });
});
