import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App.jsx';
import { WalletProvider } from './context/WalletContext.jsx';

vi.mock('./components/BotStatus', () => ({
  BotStatusBadge: () => <div data-testid="bot-status-badge">BotStatusBadge</div>,
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
    const badges = screen.getAllByTestId('bot-status-badge');
    expect(badges.length).toBeGreaterThanOrEqual(1);
    expect(badges[0]).toBeInTheDocument();
  });

  it('renders main sections', () => {
    render(<App />, { wrapper: TestWrapper });
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByText(/Solde bot/)).toBeInTheDocument();
  });
});
