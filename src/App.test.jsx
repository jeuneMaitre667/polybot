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

function TestWrapper({ children }) {
  return <WalletProvider>{children}</WalletProvider>;
}

describe('App', () => {
  it('renders header with logo', () => {
    render(<App />, { wrapper: TestWrapper });
    expect(screen.getByText(/Sniper Console/i)).toBeInTheDocument();
  });

  it('renders main sections', () => {
    render(<App />, { wrapper: TestWrapper });
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByTestId('bot-overview')).toBeInTheDocument();
  });
});
