import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App.jsx';
import { WalletProvider } from './context/WalletContext.jsx';

vi.mock('./components/BotStatus', () => ({
  BotStatusBadge: () => <div data-testid="bot-status-badge">BotStatusBadge</div>,
  BotBalanceChart: () => <div data-testid="bot-balance-chart">BotBalanceChart</div>,
}));

function TestWrapper({ children }) {
  return <WalletProvider>{children}</WalletProvider>;
}

describe('App', () => {
  it('renders header with title and bot badge', () => {
    render(<App />, { wrapper: TestWrapper });
    const header = screen.getByRole('banner');
    expect(header).toHaveTextContent('Polymarket');
    expect(header).toHaveTextContent('Bot');
    expect(screen.getByTestId('bot-status-badge')).toBeInTheDocument();
  });

  it('renders main sections', () => {
    render(<App />, { wrapper: TestWrapper });
    expect(screen.getByTestId('bot-balance-chart')).toBeInTheDocument();
  });
});
