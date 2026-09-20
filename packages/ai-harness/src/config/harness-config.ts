import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AgentDefinition, StrategyDefinition, ToolFactory } from './types';

/**
 * Everything application-specific enters the harness here and nowhere else. The
 * package reads no environment variable of its own: a library that reaches for
 * `process.env` cannot be configured twice in one process, and cannot be tested
 * without setting global state.
 */
export interface HarnessConfig {
  /**
   * The pool and the schema its tables live in. Three services here run SQL, so
   * omitting this slot would leave them with nothing to inject.
   */
  db: { pool: Pool; schema?: string };
  llm: {
    baseUrl: string;
    apiKey: string;
    chatModel: string;
    embedModel: string;
    /** Must equal the `vector(N)` of the migration; asserted by a test. */
    embedDimensions: number;
  };
  agents: AgentDefinition[];
  strategies: StrategyDefinition[];
  /** Tools known at boot. A module that needs injected services registers its own
   *  with `ToolRegistry.register` instead. */
  tools?: ToolFactory[];
  chat: {
    replayWindow: number;
    consolidateAfterMessages: number;
    /** Model round trips one turn may take; each tool result costs one. */
    maxToolRounds?: number;
  };
  /** Override the default PgVectorMemoryStore, e.g. for another vector store. */
  memoryStore?: Provider;
}

/** Schema-qualified identifier, so a configured schema cannot smuggle in SQL. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Validated at `forRoot`, not documented in a comment: every rule below is one a
 * misconfiguration would otherwise break silently, hours later, in a background
 * pass nobody is watching.
 */
const configSchema = z.object({
  db: z.object({
    pool: z.custom<Pool>((v) => typeof v === 'object' && v !== null, 'db.pool is required'),
    schema: z.string().regex(IDENTIFIER, 'db.schema must be a plain SQL identifier').default('ai'),
  }),
  llm: z.object({
    baseUrl: z.string().url(),
    apiKey: z.string().min(1),
    chatModel: z.string().min(1),
    embedModel: z.string().min(1),
    embedDimensions: z.number().int().positive(),
  }),
  agents: z.array(z.custom<AgentDefinition>()).min(1),
  strategies: z.array(z.custom<StrategyDefinition>()),
  tools: z.array(z.custom<ToolFactory>()).default([]),
  chat: z.object({
    replayWindow: z.number().int().positive(),
    /**
     * One complete turn is two messages, so 2 forms memory after every turn.
     * Above that, a short conversation never reaches the threshold and never
     * forms any memory at all — the exact bug the forward marker was introduced
     * to fix. It is a boot-time error rather than a note in a comment because the
     * symptom is silence.
     */
    consolidateAfterMessages: z
      .number()
      .int()
      .positive()
      .max(2, 'chat.consolidateAfterMessages above 2 means short conversations never form memory'),
    /**
     * A ceiling on model round trips per turn. Each tool result goes back to the
     * model, which may call another tool; without a ceiling a model that keeps
     * asking for the same tool burns budget until something else times out.
     */
    maxToolRounds: z.number().int().positive().max(20).default(6),
  }),
});

export type ResolvedHarnessConfig = Omit<z.infer<typeof configSchema>, 'agents' | 'strategies' | 'tools'> & {
  agents: AgentDefinition[];
  strategies: StrategyDefinition[];
  /** Always an array once validated; an omitted `tools` defaults to empty. */
  tools: ToolFactory[];
};

export function validateHarnessConfig(config: HarnessConfig): ResolvedHarnessConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid AiHarnessModule configuration:\n${issues}`);
  }
  const names = parsed.data.agents.map((a) => a.name);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) {
    throw new Error(`Invalid AiHarnessModule configuration:\n  - agents: duplicate agent "${duplicate}"`);
  }
  return parsed.data as ResolvedHarnessConfig;
}

/** DI tokens. Symbols, so a host application cannot collide with them by name. */
export const HARNESS_CONFIG = Symbol('HARNESS_CONFIG');
export const MEMORY_STORE = Symbol('MEMORY_STORE');
export const LLM_GATEWAY = Symbol('LLM_GATEWAY');
export const AGENT_RUNTIME = Symbol('AGENT_RUNTIME');
