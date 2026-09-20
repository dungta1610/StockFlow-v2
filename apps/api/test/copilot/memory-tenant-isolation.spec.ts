import type { INestApplication } from '@nestjs/common';
import { ChatTurnService, MEMORY_STORE, type MemoryStore } from '@stockflow/ai-harness';
import { actorsOf } from '../helpers/ordering-fixtures';
import { textTurn } from '../helpers/harness-fixtures';
import {
  contextFor,
  createCopilotApp,
  seedCopilotSession,
  seedCopilotWorld,
  type CopilotApp,
  type CopilotWorld,
} from '../helpers/copilot-fixtures';

/**
 * What one tenant's conversations teach the copilot stays with that tenant.
 *
 * The two tenants here are a real internal organisation and a real buyer
 * organisation, not two operators — every operator shares the internal
 * organisation and therefore one namespace, which is intended (what the team
 * learns about its own operation is shared) and would make a same-tenant test
 * meaningless.
 */
describe('copilot memory is per tenant', () => {
  let fixture: CopilotApp;
  let app: INestApplication;
  let world: CopilotWorld;

  beforeAll(async () => {
    fixture = await createCopilotApp();
    app = fixture.app;
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedCopilotWorld();
  });

  it('files a conversation´s memory under the caller´s organisation only', async () => {
    const actors = actorsOf(world);
    const sessionId = await seedCopilotSession(actors.ops);
    const turns = app.get(ChatTurnService);

    fixture.llm.turns = [textTurn('Noted.')];
    fixture.llm.completions = [
      {
        when: () => true,
        reply: JSON.stringify({ memories: [{ content: 'Warehouse HN-01 is counted every Friday' }] }),
      },
    ];

    const input = {
      agentName: 'ops-copilot',
      input: 'Remember: warehouse HN-01 is counted every Friday.',
      context: contextFor(actors.ops, sessionId),
    };
    await turns.run(input);
    await turns.settled();

    const store = app.get<MemoryStore>(MEMORY_STORE);
    const ours = await store.list(`org:${world.internal}:semantic`);
    expect(ours.map((m) => m.content)).toContain('Warehouse HN-01 is counted every Friday');

    // The other tenant's namespace never saw it, and a search there finds nothing.
    expect(await store.list(`org:${world.buyerA}:semantic`)).toEqual([]);
    const theirs = await store.search(
      [`org:${world.buyerA}`, `org:${world.buyerA}:semantic`],
      'Warehouse HN-01 is counted every Friday',
    );
    expect(theirs).toEqual([]);
  });

  it('recalls nothing from another organisation into the prompt', async () => {
    const actors = actorsOf(world);
    const store = app.get<MemoryStore>(MEMORY_STORE);
    await store.upsert({
      namespace: `org:${world.buyerA}:semantic`,
      content: 'Warehouse HN-01 is counted every Friday',
    });

    const sessionId = await seedCopilotSession(actors.ops);
    fixture.llm.turns = [textTurn('I do not know.')];
    fixture.llm.chatRequests.length = 0;

    await app.get(ChatTurnService).run({
      agentName: 'ops-copilot',
      input: 'Warehouse HN-01 is counted every Friday, is that still the schedule?',
      context: contextFor(actors.ops, sessionId),
    });

    const system = fixture.llm.chatRequests[0]!.messages[0]!;
    expect(system.content).not.toContain('counted every Friday');
  });
});
