import type { SessionView } from '@stockflow/contracts';
import { useSyncExternalStore } from 'react';
import { getSession, refreshSession, subscribe } from '@/lib/auth-store';

/** The current session, re-rendering when it changes in this tab or another. */
export function useSession(): SessionView | null {
  return useSyncExternalStore(subscribe, getSession, getSession);
}

/** Non-null inside the signed-in layout (the route guard guarantees it). */
export function useRequiredSession(): SessionView {
  const session = useSession();
  if (!session) throw new Error('useRequiredSession used outside the signed-in layout');
  return session;
}

let restoring: Promise<SessionView | null> | null = null;

/**
 * The access token is lost on reload, but the refresh cookie survives: try it once
 * before deciding the user is signed out.
 */
export function ensureSession(): Promise<SessionView | null> {
  const current = getSession();
  if (current) return Promise.resolve(current);
  restoring ??= refreshSession(null).finally(() => {
    restoring = null;
  });
  return restoring;
}

export const isOps = (s: SessionView) => s.acting_as.org_type === 'internal';
export const isOpsAdmin = (s: SessionView) => isOps(s) && s.acting_as.role === 'ops_admin';
/** ops_admin or buyer_admin: the only roles /users lets through at all. */
export const canManageUsers = (s: SessionView) => s.acting_as.role === 'ops_admin' || s.acting_as.role === 'buyer_admin';
