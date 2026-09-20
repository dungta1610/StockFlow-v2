import type { CopilotStreamEvent, SessionView } from '@stockflow/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api-client';
import { resetAuthForTests, setSession } from '../src/lib/auth-store';
import { streamSse } from '../src/lib/sse';
import { apply, type ChatTurn } from '../src/features/copilot/use-chat-stream';

const session = (token: string): SessionView =>
  ({ access_token: token, token_type: 'Bearer', expires_in: 900 }) as SessionView;

/** An SSE body delivered in the chunks given, so a split mid-event is exercised. */
function sseResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const event = (e: CopilotStreamEvent) => `data: ${JSON.stringify(e)}\n\n`;

beforeEach(() => {
  resetAuthForTests();
  setSession(session('good-token'), false);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SSE client', () => {
  it('parses text, tool_start, tool_end and error in order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          event({ type: 'tool_start', call_id: 'c1', name: 'get_inventory_status' }),
          event({ type: 'tool_end', call_id: 'c1', name: 'get_inventory_status', ok: true, duration_ms: 12 }),
          event({ type: 'text', delta: 'There are ' }),
          event({ type: 'text', delta: '12 units.' }),
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );

    const seen: CopilotStreamEvent[] = [];
    await streamSse<CopilotStreamEvent>({ path: '/copilot/sessions/s1/messages', body: { input: 'x' }, onEvent: (e) => seen.push(e) });

    expect(seen.map((e) => e.type)).toEqual(['tool_start', 'tool_end', 'text', 'text']);
    expect(seen[1]).toMatchObject({ call_id: 'c1', ok: true, duration_ms: 12 });
  });

  it('reassembles an event split across network chunks', async () => {
    const whole = event({ type: 'text', delta: 'a long answer that arrived in pieces' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([whole.slice(0, 11), whole.slice(11, 30), whole.slice(30)])),
    );

    const seen: CopilotStreamEvent[] = [];
    await streamSse<CopilotStreamEvent>({ path: '/copilot/sessions/s1/messages', body: {}, onEvent: (e) => seen.push(e) });

    expect(seen).toEqual([{ type: 'text', delta: 'a long answer that arrived in pieces' }]);
  });

  it('sends the token in a header and never in the URL', async () => {
    const fetchMock = vi.fn(async () => sseResponse([event({ type: 'text', delta: 'ok' })]));
    vi.stubGlobal('fetch', fetchMock);

    await streamSse<CopilotStreamEvent>({ path: '/copilot/sessions/s1/messages', body: {}, onEvent: () => undefined });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer good-token');
    expect(new Headers(init.headers).get('Accept')).toBe('text/event-stream');
    // The reason this client exists instead of EventSource: a token in the query
    // string lands in history, proxy logs and the Referer of the next request.
    expect(url).not.toContain('good-token');
    expect(new URL(url).search).toBe('');
  });

  it('surfaces a failed request instead of hanging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'COPILOT_RATE_LIMITED', message: 'Too many messages.' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    await expect(
      streamSse<CopilotStreamEvent>({ path: '/copilot/sessions/s1/messages', body: {}, onEvent: () => undefined }),
    ).rejects.toMatchObject({ status: 429, code: 'COPILOT_RATE_LIMITED' });
  });

  it('refreshes once on a 401 and retries the stream', async () => {
    const calls: (string | null)[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      const auth = new Headers(init.headers).get('Authorization');
      if (path === '/auth/refresh') {
        return new Response(JSON.stringify({ data: session('fresh-token') }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      calls.push(auth);
      return auth === 'Bearer fresh-token'
        ? sseResponse([event({ type: 'text', delta: 'ok' })])
        : new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'expired' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
    });
    vi.stubGlobal('fetch', fetchMock);

    const seen: CopilotStreamEvent[] = [];
    await streamSse<CopilotStreamEvent>({ path: '/copilot/sessions/s1/messages', body: {}, onEvent: (e) => seen.push(e) });

    expect(calls).toEqual(['Bearer good-token', 'Bearer fresh-token']);
    expect(seen).toEqual([{ type: 'text', delta: 'ok' }]);
  });

  it('gives up cleanly when the refresh fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        new Response(
          JSON.stringify(
            new URL(url).pathname === '/auth/refresh'
              ? { error: { code: 'REFRESH_TOKEN_INVALID', message: 'Session expired.' } }
              : { error: { code: 'UNAUTHORIZED', message: 'expired' } },
          ),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(
      streamSse<CopilotStreamEvent>({ path: '/copilot/sessions/s1/messages', body: {}, onEvent: () => undefined }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('stops the stream when the caller aborts', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return sseResponse([event({ type: 'text', delta: 'ok' })]);
      }),
    );

    controller.abort();
    await expect(
      streamSse<CopilotStreamEvent>({
        path: '/copilot/sessions/s1/messages',
        body: {},
        signal: controller.signal,
        onEvent: () => undefined,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('folding stream events into a turn', () => {
  const empty: ChatTurn = { role: 'assistant', content: '', toolCalls: [] };

  it('appends text deltas', () => {
    const turn = [{ type: 'text', delta: 'a' }, { type: 'text', delta: 'b' }].reduce(
      (t, e) => apply(t, e as CopilotStreamEvent),
      empty,
    );
    expect(turn.content).toBe('ab');
  });

  it('matches tool_end to tool_start by call id, not by position', () => {
    // Two tools running at once, finishing in the opposite order. Matching by
    // position would mark the wrong one as failed.
    const turn = (
      [
        { type: 'tool_start', call_id: 'c1', name: 'find_orders' },
        { type: 'tool_start', call_id: 'c2', name: 'get_inventory_status' },
        { type: 'tool_end', call_id: 'c2', name: 'get_inventory_status', ok: true, duration_ms: 5 },
        { type: 'tool_end', call_id: 'c1', name: 'find_orders', ok: false, duration_ms: 9 },
      ] as CopilotStreamEvent[]
    ).reduce(apply, empty);

    expect(turn.toolCalls).toEqual([
      { callId: 'c1', name: 'find_orders', ok: false, durationMs: 9 },
      { callId: 'c2', name: 'get_inventory_status', ok: true, durationMs: 5 },
    ]);
  });

  it('records an error event on the turn', () => {
    const turn = apply(empty, { type: 'error', message: 'ran out of tool rounds' });
    expect(turn.error).toBe('ran out of tool rounds');
  });
});
