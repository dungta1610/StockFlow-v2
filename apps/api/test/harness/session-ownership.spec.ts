import { SessionService, SessionSummaryService } from '@stockflow/ai-harness';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildHarness, ORG_A, ORG_B, USER_A, USER_B, type HarnessFixture } from '../helpers/harness-fixtures';

/**
 * A chat session belongs to somebody.
 *
 * The harness this was ported from had four columns on `chat_sessions` and no
 * owner, so holding an id was the same as being allowed to read the transcript.
 * A role guard does not close that: a role says what a caller may do, not whose
 * data they may see. Tenancy is a column, and every read filters on it.
 */
describe('session ownership', () => {
  let fixture: HarnessFixture;
  let sessions: SessionService;
  let sessionId: string;

  beforeEach(async () => {
    fixture = await buildHarness();
    sessions = fixture.module.get(SessionService);
    const created = await sessions.create('assistant', { tenantId: ORG_A, ownerUserId: USER_A });
    sessionId = created.id;
    await sessions.addMessage(sessionId, { tenantId: ORG_A }, 'user', 'confidential question');
  });
  afterEach(() => fixture.close());

  it('does not return a session to another tenant', async () => {
    expect(await sessions.get(sessionId, { tenantId: ORG_A })).not.toBeNull();
    expect(await sessions.get(sessionId, { tenantId: ORG_B })).toBeNull();
  });

  it('does not return its messages to another tenant', async () => {
    expect(await sessions.getMessages(sessionId, { tenantId: ORG_A })).toHaveLength(1);
    expect(await sessions.getMessages(sessionId, { tenantId: ORG_B })).toEqual([]);
  });

  it('does not list it for another tenant', async () => {
    expect(await sessions.list({ tenantId: ORG_A })).toHaveLength(1);
    expect(await sessions.list({ tenantId: ORG_B })).toEqual([]);
  });

  it('narrows a listing to one owner when asked', async () => {
    await sessions.create('assistant', { tenantId: ORG_A, ownerUserId: USER_B });
    expect(await sessions.list({ tenantId: ORG_A })).toHaveLength(2);
    expect(await sessions.list({ tenantId: ORG_A, ownerUserId: USER_A })).toHaveLength(1);
  });

  it('refuses to append a message on behalf of another tenant', async () => {
    await expect(sessions.addMessage(sessionId, { tenantId: ORG_B }, 'user', 'injected')).rejects.toThrow(
      /not found in this tenant/,
    );
    expect(await sessions.getMessages(sessionId, { tenantId: ORG_A })).toHaveLength(1);
  });

  it('does not claim a consolidation pass on behalf of another tenant', async () => {
    await sessions.addMessage(sessionId, { tenantId: ORG_A }, 'assistant', 'answer');
    expect(await sessions.claimConsolidation(sessionId, { tenantId: ORG_B }, 2)).toBe(false);
    expect(await sessions.claimConsolidation(sessionId, { tenantId: ORG_A }, 2)).toBe(true);
  });

  it('does not return a running summary to another tenant', async () => {
    await fixture.pool.query(
      `INSERT INTO ai.session_summaries (session_id, summary, covered_through) VALUES ($1, $2, $3)`,
      [sessionId, 'the conversation so far', 1],
    );
    const summaries = fixture.module.get(SessionSummaryService);

    expect(await summaries.get(sessionId, { tenantId: ORG_A })).not.toBeNull();
    expect(await summaries.get(sessionId, { tenantId: ORG_B })).toBeNull();
  });

  it('has no read method that can be called without a tenant', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../../packages/ai-harness/src/session/session.service.ts'),
      'utf8',
    );
    // Template literals that actually start a statement — a backtick in a
    // doc comment is not SQL, and matching those instead would test prose.
    const statements = [...source.matchAll(/`(\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*)`/gi)].map((m) => m[1]!);

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      // Creating a session supplies the tenant; there is no prior row for a
      // clause to protect. Everything else touches a session it was not handed,
      // so the clause is what scopes it.
      const creates = /^\s*INSERT INTO [^\n]*chat_sessions/i.test(statement);
      expect(statement, statement.slice(0, 90)).toMatch(creates ? /\(agent_name, tenant_id,/ : /tenant_id = \$/);
    }
  });
});
