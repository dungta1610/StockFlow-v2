import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bearer } from '../helpers/identity-fixtures';
import { actorsOf } from '../helpers/ordering-fixtures';
import {
  createCopilotApp,
  seedCopilotSession,
  seedCopilotWorld,
  type CopilotWorld,
} from '../helpers/copilot-fixtures';

/**
 * Nobody reads or writes somebody else's conversation.
 *
 * This is the largest leak the copilot could introduce, and it is easy to miss:
 * a transcript holds whatever the tools looked up on the operator's behalf, so
 * reading one is reading the data behind it — with none of the scope checks that
 * protected the data in the first place. The answer is 404, not 403: a wrong
 * answer must not confirm the session exists.
 */
describe('copilot session ownership', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let world: CopilotWorld;
  let opsSession: string;

  beforeAll(async () => {
    ({ app } = await createCopilotApp());
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  beforeEach(async () => {
    world = await seedCopilotWorld();
    opsSession = await seedCopilotSession(actorsOf(world).ops);
  });

  it('lets the owning tenant read its own session', async () => {
    const auth = await bearer(server, 'ops@sf.test');
    const res = await request(server).get(`/copilot/sessions/${opsSession}`).set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.data.session.id).toBe(opsSession);
  });

  it('keeps the copilot away from buyers entirely', async () => {
    const auth = await bearer(server, 'buyer@a.test');

    expect((await request(server).get('/copilot/sessions').set('Authorization', auth)).status).toBe(403);
    expect((await request(server).post('/copilot/sessions').set('Authorization', auth).send({})).status).toBe(403);
  });

  it('hides a session belonging to another tenant behind a 404', async () => {
    // A session owned by a buyer organisation: the operator's tenant is a different
    // one, so it must be invisible in both directions.
    const buyerSession = await seedCopilotSession(actorsOf(world).buyerA);
    const auth = await bearer(server, 'ops@sf.test');

    const read = await request(server).get(`/copilot/sessions/${buyerSession}`).set('Authorization', auth);
    expect(read.status).toBe(404);

    const write = await request(server)
      .post(`/copilot/sessions/${buyerSession}/messages`)
      .set('Authorization', auth)
      .send({ input: 'what is in here?' });
    expect(write.status).toBe(404);
  });

  it('does not list another tenant´s sessions', async () => {
    await seedCopilotSession(actorsOf(world).buyerA);
    const auth = await bearer(server, 'ops@sf.test');

    const res = await request(server).get('/copilot/sessions').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([opsSession]);
  });
});
