import type { SessionView } from '@stockflow/contracts';

/**
 * The session lives in memory only: the access token never touches storage, and the
 * refresh token is an HttpOnly cookie JavaScript cannot read (docs/adr/0009).
 *
 * Refresh is serialised twice over:
 * - inside a tab, concurrent 401s share one in-flight promise;
 * - across tabs, the Web Locks API queues refreshes, and a tab that waited checks
 *   whether another tab already refreshed before spending the cookie itself.
 * Without that, two tabs would present the same rotating refresh token, the server
 * would see a reuse and revoke the whole session family, and both tabs would be
 * logged out (test/verification/concurrent-refresh.spec.ts in the API).
 */

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3100';

type Listener = (session: SessionView | null) => void;

let session: SessionView | null = null;
const listeners = new Set<Listener>();

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('sf-auth') : null;
// Outside a browser (unit tests on Node) an open channel would keep the process alive.
(channel as { unref?: () => void } | null)?.unref?.();
type AuthMessage = { type: 'session'; session: SessionView } | { type: 'logout' };

channel?.addEventListener('message', (event: MessageEvent<AuthMessage>) => {
  // Another tab logged in, refreshed or logged out: every tab shares one identity,
  // because they share one refresh cookie.
  setSession(event.data.type === 'session' ? event.data.session : null, false);
});

/** When another tab last refreshed, so a tab that waited on the lock can wait for its broadcast. */
const REFRESHED_AT_KEY = 'sf-refreshed-at';

export function getSession(): SessionView | null {
  return session;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSession(next: SessionView | null, broadcast = true): void {
  session = next;
  if (broadcast) channel?.postMessage(next ? { type: 'session', session: next } : { type: 'logout' });
  for (const listener of listeners) listener(next);
}

let inflight: Promise<SessionView | null> | null = null;

/**
 * Gets a fresh session. `staleToken` is the access token the caller saw rejected
 * (null on first load): if the session already moved past it, nothing is spent.
 */
export function refreshSession(staleToken: string | null): Promise<SessionView | null> {
  if (session && session.access_token !== staleToken) return Promise.resolve(session);
  inflight ??= withRefreshLock(async () => {
    if (session && session.access_token !== staleToken) return session;
    await waitForRecentBroadcast(staleToken);
    if (session && session.access_token !== staleToken) return session;

    const res = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (!res.ok) {
      setSession(null);
      return null;
    }
    const next = ((await res.json()) as { data: SessionView }).data;
    markRefreshed();
    setSession(next);
    return next;
  }).finally(() => {
    inflight = null;
  });
  return inflight;
}

function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  // request() resolves with the callback's own result once the lock is released.
  return locks ? (locks.request('sf-refresh', fn) as Promise<T>) : fn();
}

/**
 * Lock order and message delivery are not ordered across tabs: the tab that just
 * refreshed may release the lock before its broadcast reaches us. If it refreshed in
 * the last few seconds, give the broadcast a moment instead of spending the cookie.
 */
async function waitForRecentBroadcast(staleToken: string | null): Promise<void> {
  const at = Number(safeStorage()?.getItem(REFRESHED_AT_KEY) ?? 0);
  if (Date.now() - at > 5_000) return;
  for (let i = 0; i < 10; i++) {
    if (session && session.access_token !== staleToken) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function markRefreshed(): void {
  safeStorage()?.setItem(REFRESHED_AT_KEY, String(Date.now()));
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Test hook: forget everything between tests. */
export function resetAuthForTests(): void {
  session = null;
  inflight = null;
  listeners.clear();
}
