import type { ErrorEnvelope, SessionView } from '@stockflow/contracts';
import { API_URL, getSession, refreshSession, setSession } from './auth-store';

/** A failed API call, keeping the stable `code` the API sends so screens can branch on it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
}

/**
 * Calls the API with the in-memory access token. On a 401 it refreshes once —
 * concurrent callers share that refresh — and retries the same request. If the
 * refresh fails the session is cleared and the router sends the user to /login.
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const send = (token: string | null) =>
    fetch(`${API_URL}${path}${queryString(opts.query)}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  const token = getSession()?.access_token ?? null;
  let res = await send(token);
  if (res.status === 401) {
    const fresh = await refreshSession(token);
    if (!fresh) throw new ApiError(401, 'UNAUTHORIZED', 'Your session has ended. Sign in again.');
    res = await send(fresh.access_token);
  }
  return parse<T>(res);
}

export async function login(input: { email: string; password: string; org_code?: string }): Promise<SessionView> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    // Needed for the browser to store the refresh cookie from a cross-origin response.
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const session = (await parse<{ data: SessionView }>(res)).data;
  setSession(session);
  return session;
}

export async function logout(): Promise<void> {
  await fetch(`${API_URL}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
  setSession(null);
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (body as ErrorEnvelope | null)?.error;
    throw new ApiError(res.status, error?.code ?? 'HTTP_ERROR', error?.message ?? `Request failed (${res.status}).`, error?.details);
  }
  return body as T;
}

function queryString(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}
