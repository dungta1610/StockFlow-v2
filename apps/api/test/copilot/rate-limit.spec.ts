import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../src/platform/config/env.schema';
import request from 'supertest';
import { textTurn } from '../helpers/harness-fixtures';
import { bearer } from '../helpers/identity-fixtures';
import { actorsOf } from '../helpers/ordering-fixtures';
import {
  createCopilotApp,
  seedCopilotSession,
  seedCopilotWorld,
  type CopilotApp,
  type CopilotWorld,
} from '../helpers/copilot-fixtures';

/**
 * The copilot's own ceiling is per user, not per IP.
 *
 * What is being bounded here is model spend, and spend belongs to whoever caused
 * it. A whole office behind one address would otherwise share a budget, so one
 * person's runaway script would lock out everybody sitting next to them — which
 * is exactly the failure a rate limit is supposed to prevent.
 */
describe('copilot rate limit', () => {
  let fixture: CopilotApp;
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let world: CopilotWorld;
  let max: number;

  beforeAll(async () => {
    fixture = await createCopilotApp();
    app = fixture.app;
    server = app.getHttpServer();
    max = app.get<ConfigService<Env, true>>(ConfigService).get('COPILOT_RATE_LIMIT_PER_MIN', { infer: true });
  });
  afterAll(() => app.close());

  beforeEach(async () => {
    world = await seedCopilotWorld();
  });

  async function sendTurns(email: string, sessionId: string, count: number): Promise<number[]> {
    const auth = await bearer(server, email);
    const statuses: number[] = [];
    for (let i = 0; i < count; i++) {
      fixture.llm.turns = [textTurn('ok')];
      const res = await request(server)
        .post(`/copilot/sessions/${sessionId}/messages`)
        .set('Authorization', auth)
        .send({ input: `question ${i}` });
      statuses.push(res.status);
    }
    return statuses;
  }

  it('refuses a user past the ceiling and leaves another user alone', async () => {
    const actors = actorsOf(world);
    const opsSession = await seedCopilotSession(actors.ops);
    const adminSession = await seedCopilotSession(actors.opsAdmin);

    const statuses = await sendTurns('ops@sf.test', opsSession, max + 1);

    expect(statuses.slice(0, max).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);

    // The other operator shares the address and the organisation; their budget is
    // untouched.
    expect(await sendTurns('ops.admin@sf.test', adminSession, 1)).toEqual([200]);
  });

  it('says how long to wait', async () => {
    const opsSession = await seedCopilotSession(actorsOf(world).ops);
    await sendTurns('ops@sf.test', opsSession, max);

    const res = await request(server)
      .post(`/copilot/sessions/${opsSession}/messages`)
      .set('Authorization', await bearer(server, 'ops@sf.test'))
      .send({ input: 'one more' });

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body.error.code).toBe('COPILOT_RATE_LIMITED');
  });
});
