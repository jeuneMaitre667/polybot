import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBotStatus } from './useBotStatus.js';

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
