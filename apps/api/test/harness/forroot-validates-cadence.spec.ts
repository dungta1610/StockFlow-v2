import { validateHarnessConfig, calculatorTool, type HarnessConfig } from '@stockflow/ai-harness';
import type { Pool } from 'pg';
import { testAgent, testStrategy } from '../helpers/harness-fixtures';

/**
 * Configuration mistakes that would otherwise surface as silence, made into boot
 * failures.
 *
 * `consolidateAfterMessages` above 2 is the important one: one complete turn is
 * two messages, so a higher cadence means a short conversation never reaches the
 * threshold and never forms any memory at all. Nothing errors — memory simply
 * never appears, which is the hardest kind of bug to notice.
 */
describe('AiHarnessModule.forRoot validation', () => {
  const base: HarnessConfig = {
    db: { pool: {} as Pool, schema: 'ai' },
    llm: {
      baseUrl: 'http://litellm.invalid',
      apiKey: 'test',
      chatModel: 'default-chat',
      embedModel: 'default-embed',
      embedDimensions: 1024,
    },
    agents: [testAgent],
    strategies: [testStrategy],
    tools: [calculatorTool],
    chat: { replayWindow: 8, consolidateAfterMessages: 2 },
  };

  it('accepts a cadence of one turn', () => {
    expect(() => validateHarnessConfig(base)).not.toThrow();
  });

  it('rejects a cadence above one turn', () => {
    expect(() => validateHarnessConfig({ ...base, chat: { replayWindow: 8, consolidateAfterMessages: 3 } })).toThrow(
      /consolidateAfterMessages above 2/,
    );
  });

  it('rejects a schema name that is not a plain identifier', () => {
    expect(() => validateHarnessConfig({ ...base, db: { pool: {} as Pool, schema: 'ai; drop table x' } })).toThrow(
      /plain SQL identifier/,
    );
  });

  it('rejects two agents with the same name', () => {
    expect(() => validateHarnessConfig({ ...base, agents: [testAgent, testAgent] })).toThrow(/duplicate agent/);
  });

  it('defaults the schema rather than leaving it undefined', () => {
    const resolved = validateHarnessConfig({ ...base, db: { pool: {} as Pool } });
    expect(resolved.db.schema).toBe('ai');
  });
});
