import type { SessionView } from '@stockflow/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/lib/api-client';
import { getSession, resetAuthForTests, setSession } from '../src/lib/auth-store';

const session = (token: string): SessionView =>
  ({ access_token: token, token_type: 'Bearer', expires_in: 900 }) as SessionView;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * A fake API: `/auth/refresh` issues `fresh-token`; every other path answers 200 only
 * for that token and 401 otherwise. Records each call.
 */
function fakeApi(opts: { refreshOk?: boolean; refreshDelayMs?: number } = {}) {
  const calls: { path: string; auth: string | null }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const auth = new Headers(init.headers).get('Authorization');
    calls.push({ path, auth });
    if (path === '/auth/refresh') {
      await new Promise((r) => setTimeout(r, opts.refreshDelayMs ?? 10));
      return opts.refreshOk === false
        ? json(401, { error: { code: 'REFRESH_TOKEN_INVALID', message: 'Session expired.' } })
        : json(200, { data: session('fresh-token') });
    }
    return auth === 'Bearer fresh-token'
      ? json(200, { data: { path } })
      : json(401, { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, refreshCalls: () => calls.filter((c) => c.path === '/auth/refresh').length };
}

beforeEach(() => {
  resetAuthForTests();
  setSession(session('expired-token'), false);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('turns the error envelope into an ApiError that keeps code, status and details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(409, { error: { code: 'INSUFFICIENT_STOCK', message: 'Not enough stock.', details: { sku: 'A4' } } }),
      ),
    );
    const err = await api('/orders', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK', message: 'Not enough stock.', details: { sku: 'A4' } });
  });

  it('on 401 refreshes and retries the same request with the new token', async () => {
    const { calls } = fakeApi();
    await expect(api('/orders')).resolves.toEqual({ data: { path: '/orders' } });
    expect(calls.map((c) => `${c.path} ${c.auth}`)).toEqual([
      '/orders Bearer expired-token',
      '/auth/refresh null',
      '/orders Bearer fresh-token',
    ]);
    expect(getSession()?.access_token).toBe('fresh-token');
  });

  it('when the refresh fails, clears the session and reports 401', async () => {
    fakeApi({ refreshOk: false });
    await expect(api('/orders')).rejects.toMatchObject({ status: 401 });
    expect(getSession()).toBeNull();
  });

  it('never puts the token in the URL', async () => {
    const { calls } = fakeApi();
    await api('/orders', { query: { status: 'reserved' } });
    const fetchMock = vi.mocked(fetch);
    for (const [url] of fetchMock.mock.calls) expect(String(url)).not.toContain('token');
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('refresh mutex', () => {
  it('5 concurrent requests hitting 401 refresh exactly once, and all 5 succeed', async () => {
    const { refreshCalls } = fakeApi({ refreshDelayMs: 30 });
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => api(`/r${i}`)));

    // With rotating refresh tokens, a second refresh would present a used token and
    // the server would revoke the whole session.
    expect(refreshCalls()).toBe(1);
    expect(results).toEqual(Array.from({ length: 5 }, (_, i) => ({ data: { path: `/r${i}` } })));
  });

  it('a request sent with the old token does not refresh if the session moved on meanwhile', async () => {
    const { refreshCalls } = fakeApi();
    // The request leaves with the expired token; before its 401 comes back, another
    // tab refreshes and broadcasts the new session.
    vi.mocked(fetch).mockImplementationOnce(async () => {
      setSession(session('fresh-token'), false);
      return json(401, { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } });
    });
    await expect(api('/slow')).resolves.toEqual({ data: { path: '/slow' } });
    expect(refreshCalls()).toBe(0);
  });
});
