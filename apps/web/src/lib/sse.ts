import type { ErrorEnvelope } from '@stockflow/contracts';
import { ApiError } from './api-client';
import { API_URL, getSession, refreshSession } from './auth-store';

/**
 * Server-sent events over `fetch`, not `EventSource`.
 *
 * `EventSource` cannot set headers, so every example of it with a private API ends
 * up putting the token in the query string — where it lands in browser history,
 * proxy logs and the Referer of anything the page loads next. A token belongs in
 * an `Authorization` header, and that alone rules the browser's built-in client
 * out.
 *
 * It also gives us the two things this screen needs and `EventSource` does not: a
 * stop button (`AbortController`) and a failure that surfaces instead of silently
 * reconnecting for ever.
 */
export interface SseOptions<T> {
  path: string;
  body: unknown;
  signal?: AbortSignal;
  /** Called for each parsed event, in order. */
  onEvent: (event: T) => void;
}

export async function streamSse<T>({ path, body, signal, onEvent }: SseOptions<T>): Promise<void> {
  const send = (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });

  const token = getSession()?.access_token ?? null;
  let res = await send(token);
  // The same one-shot refresh the plain client does; concurrent callers share it.
  if (res.status === 401) {
    const fresh = await refreshSession(token);
    if (!fresh) throw new ApiError(401, 'UNAUTHORIZED', 'Your session has ended. Sign in again.');
    res = await send(fresh.access_token);
  }
  if (!res.ok) throw await toApiError(res);
  if (!res.body) throw new ApiError(res.status, 'STREAM_FAILED', 'The server sent no response body.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // An event can straddle two network chunks, so the buffer is only consumed
      // up to the last complete line — parsing each read on its own would drop
      // exactly the long text deltas this screen is made of.
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data.length === 0 || data === '{}') continue;
        onEvent(JSON.parse(data) as T);
      }
    }
  } finally {
    // Releasing matters on an aborted stream: without it the connection is held
    // until garbage collection, and a user who stops three answers in a row ends
    // up with three sockets they are still paying for.
    reader.releaseLock();
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  const error = (body as ErrorEnvelope | null)?.error;
  return new ApiError(
    res.status,
    error?.code ?? 'HTTP_ERROR',
    error?.message ?? `The assistant could not be reached (${res.status}).`,
    error?.details,
  );
}
