import { ToolRegistry, defineTool, toolFactory, type RunContext, type ToolFactory } from '@stockflow/ai-harness';
import { z } from 'zod';
import { buildHarness, ORG_A, ORG_B, USER_A, USER_B, type HarnessFixture } from '../helpers/harness-fixtures';

/**
 * Tools are built per request, from factories.
 *
 * A registry of instances built once at boot cannot be right for a tool that
 * reaches real data: the instance either has no caller at all, or — worse —
 * captures the first one and hands their scope to everybody after. Building per
 * request makes that impossible to express.
 */
describe('ToolRegistry builds per request', () => {
  let fixture: HarnessFixture;
  let registry: ToolRegistry;
  const seen: string[] = [];

  /** A tool that answers with the tenant it was built for. */
  const whoAmI: ToolFactory = toolFactory('who_am_i', (ctx: RunContext) =>
    defineTool({
      name: 'who_am_i',
      description: 'Report the caller this tool was built for.',
      schema: z.object({}),
      handler: async () => {
        seen.push(ctx.principal.tenantId);
        return ctx.principal.tenantId;
      },
    }),
  );

  const ctxA: RunContext = { sessionId: 's-a', principal: { id: USER_A, tenantId: ORG_A } };
  const ctxB: RunContext = { sessionId: 's-b', principal: { id: USER_B, tenantId: ORG_B } };

  beforeEach(async () => {
    seen.length = 0;
    fixture = await buildHarness({ tools: [whoAmI] });
    registry = fixture.module.get(ToolRegistry);
  });
  afterEach(() => fixture.close());

  it('hands two callers two different instances', () => {
    const [forA] = registry.build(['who_am_i'], ctxA);
    const [forB] = registry.build(['who_am_i'], ctxB);
    expect(forA).not.toBe(forB);
  });

  it('gives each instance its own caller, with no leak between them', async () => {
    const [forA] = registry.build(['who_am_i'], ctxA);
    const [forB] = registry.build(['who_am_i'], ctxB);

    expect(await forA!.handler({})).toBe(ORG_A);
    expect(await forB!.handler({})).toBe(ORG_B);
    // Calling A again after B must still answer A.
    expect(await forA!.handler({})).toBe(ORG_A);
    expect(seen).toEqual([ORG_A, ORG_B, ORG_A]);
  });

  it('refuses an unknown tool name rather than silently dropping it', () => {
    expect(() => registry.build(['not_a_tool'], ctxA)).toThrow(/Unknown tool\(s\) not_a_tool/);
  });
});
