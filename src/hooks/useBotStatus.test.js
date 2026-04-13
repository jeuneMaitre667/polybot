import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBotStatus, normalizeBotStatusUrl, areBotStatusUrlsDuplicate } from './useBotStatus.js';

describe('normalizeBotStatusUrl', () => {
  it('trim et retire le slash final', () => {
    expect(normalizeBotStatusUrl('  http://a:3001/  ')).toBe('http://a:3001');
  });
});

describe('areBotStatusUrlsDuplicate', () => {
  it('retourne faux si une URL est vide', () => {
    expect(areBotStatusUrlsDuplicate('', 'http://x:3001')).toBe(false);
    expect(areBotStatusUrlsDuplicate('http://x:3001', '')).toBe(false);
  });
  it('retourne vrai si les deux URLs normalisées sont identiques', () => {
    expect(areBotStatusUrlsDuplicate('http://x:3001/', 'http://x:3001')).toBe(true);
  });
});

describe('useBotStatus', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('does not fetch when url is empty', async () => {
    const { result } = renderHook(() => useBotStatus(''));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toBe(null);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not fetch when url does not start with http', async () => {
    const { result } = renderHook(() => useBotStatus('ftp://localhost'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches and sets data when url is valid', async () => {
    const mockData = { status: 'online', balanceUsd: 100 };
    fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockData),
    });
    const { result } = renderHook(() => useBotStatus('http://localhost:3001'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toEqual(mockData);
    expect(result.current.error).toBe(null);
  });

  it('sets error on fetch failure', async () => {
    fetch.mockRejectedValueOnce(new Error('Network error'));
    const { result } = renderHook(() => useBotStatus('http://localhost:3001'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toBe(null);
    expect(result.current.error).toBeTruthy();
  });
});
