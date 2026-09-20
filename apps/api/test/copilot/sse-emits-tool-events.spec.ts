import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { textTurn, toolTurn } from '../helpers/harness-fixtures';
import { bearer } from '../helpers/identity-fixtures';
import { actorsOf, stockUp } from '../helpers/ordering-fixtures';
import {
  createCopilotApp,
  seedCopilotSession,
  seedCopilotWorld,
  type CopilotApp,
  type CopilotWorld,
} from '../helpers/copilot-fixtures';

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

/** Parses an SSE body into the events it carried. */
function parseSse(body: string): StreamEvent[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .filter((data) => data !== '{}')
    .map((data) => JSON.parse(data) as StreamEvent);
}

/**
 * What the console needs in order to show an answer's provenance.
 *
 * An operator acting on a number the copilot said should be able to see which
 * tool produced it and when. That is why the stream carries tool events at all —
 * and why they are on the wire contract rather than being a debugging aid.
 */
describe('copilot SSE carries tool events', () => {
  let fixture: CopilotApp;
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let world: CopilotWorld;
  let sessionId: string;

  beforeAll(async () => {
    fixture = await createCopilotApp();
    app = fixture.app;
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  beforeEach(async () => {
    world = await seedCopilotWorld();
    await stockUp(app, world, world.productId, world.warehouseId, 12);
    sessionId = await seedCopilotSession(actorsOf(world).ops);
  });

  it('streams tool_start, tool_end and the answer text', async () => {
    fixture.llm.turns = [
      toolTurn('call_1', 'get_inventory_status', { sku: 'SKU-1' }),
      textTurn('There are 12 units of SKU-1.'),
    ];

    const res = await request(server)
      .post(`/copilot/sessions/${sessionId}/messages`)
      .set('Authorization', await bearer(server, 'ops@sf.test'))
      .set('Accept', 'text/event-stream')
      .send({ input: 'how much SKU-1 do we have?' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);

    const events = parseSse(res.text);
    const start = events.find((e) => e.type === 'tool_start');
    const end = events.find((e) => e.type === 'tool_end');

    expect(start).toMatchObject({ call_id: 'call_1', name: 'get_inventory_status' });
    expect(end).toMatchObject({ call_id: 'call_1', name: 'get_inventory_status', ok: true });
    expect(end!.duration_ms as number).toBeGreaterThan(0);
    expect(
      events.filter((e) => e.type === 'text').map((e) => e.delta as string).join(''),
    ).toBe('There are 12 units of SKU-1.');
  });

  it('does not put tool arguments on the wire', async () => {
    fixture.llm.turns = [
      toolTurn('call_1', 'get_inventory_status', { sku: 'SKU-1' }),
      textTurn('Twelve.'),
    ];

    const res = await request(server)
      .post(`/copilot/sessions/${sessionId}/messages`)
      .set('Authorization', await bearer(server, 'ops@sf.test'))
      .set('Accept', 'text/event-stream')
      .send({ input: 'how much SKU-1?' });

    const start = parseSse(res.text).find((e) => e.type === 'tool_start')!;
    expect(Object.keys(start).sort()).toEqual(['call_id', 'name', 'type']);
  });

  it('persists the turn, so the transcript matches what was streamed', async () => {
    fixture.llm.turns = [textTurn('Nothing is overdue.')];

    await request(server)
      .post(`/copilot/sessions/${sessionId}/messages`)
      .set('Authorization', await bearer(server, 'ops@sf.test'))
      .set('Accept', 'text/event-stream')
      .send({ input: 'anything overdue?' });

    const res = await request(server)
      .get(`/copilot/sessions/${sessionId}`)
      .set('Authorization', await bearer(server, 'ops@sf.test'));

    expect(res.body.data.messages.map((m: { role: string; content: string }) => `${m.role}:${m.content}`)).toEqual([
      'user:anything overdue?',
      'assistant:Nothing is overdue.',
    ]);
  });
});
