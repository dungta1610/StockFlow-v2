import { Test, type TestingModule } from '@nestjs/testing';
import {
  AGENT_RUNTIME,
  AiHarnessModule,
  LLM_GATEWAY,
  calculatorTool,
  type AgentDefinition,
  type AgentRuntime,
  type ChatRequest,
  type ChatStreamChunk,
  type EmbeddingPurpose,
  type HarnessConfig,
  type LlmGateway,
  type StrategyDefinition,
  type ToolFactory,
} from '@stockflow/ai-harness';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/platform/database/pool';

/** Must equal the `vector(N)` of db/migrations/009_ai_memory.sql. */
export const EMBED_DIMENSIONS = 1024;

/**
 * Embeddings that behave like the real thing without a provider.
 *
 * A bag-of-tokens vector: identical text embeds identically (so deduplication is
 * exercised), text sharing words lands close, unrelated text lands far apart. One
 * dimension carries the input type with a small weight, which reproduces the
 * property the cache key exists for — the same sentence stored and searched for
 * does not embed to the same vector — without disturbing the ranking.
 */
export function fakeEmbedding(text: string, purpose: EmbeddingPurpose): number[] {
  const vector = new Array<number>(EMBED_DIMENSIONS).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
  for (const token of tokens) {
    const slot = 1 + (parseInt(createHash('sha1').update(token).digest('hex').slice(0, 8), 16) % (EMBED_DIMENSIONS - 1));
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  vector[0] = purpose === 'query' ? 0.15 : -0.15;

  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}

/** One scripted model turn: the chunks `streamChat` yields for it. */
export type ScriptedTurn = ChatStreamChunk[];

/**
 * A gateway under the test's control.
 *
 * Every test in this directory binds this instead of LiteLlmGateway, which is why
 * none of them needs a network, a credential or a budget. `completions` is
 * consulted by prompt content because a consolidation pass makes two structurally
 * different calls — extraction, then adjudication.
 */
export class FakeLlmGateway implements LlmGateway {
  readonly chatRequests: ChatRequest[] = [];
  readonly completePrompts: string[] = [];
  readonly embedCalls: Array<{ text: string; purpose: EmbeddingPurpose }> = [];

  /** Queued model turns, consumed one per `streamChat`. */
  turns: ScriptedTurn[] = [];
  /** Answers `complete` by the first matcher whose predicate accepts the prompt. */
  completions: Array<{ when: (prompt: string) => boolean; reply: string }> = [];

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    this.chatRequests.push(request);
    const turn = this.turns.shift() ?? [{ textDelta: '(no scripted turn)' }];
    for (const chunk of turn) yield chunk;
  }

  async complete(prompt: string): Promise<string> {
    this.completePrompts.push(prompt);
    return this.completions.find((c) => c.when(prompt))?.reply ?? '{}';
  }

  async embed(text: string, purpose: EmbeddingPurpose): Promise<number[]> {
    this.embedCalls.push({ text, purpose });
    return fakeEmbedding(text, purpose);
  }
}

/** A model turn that answers with text and calls no tool. */
export function textTurn(text: string): ScriptedTurn {
  return [{ textDelta: text }, { finishReason: 'stop' }];
}

/**
 * A model turn that asks for one tool, with the arguments split across chunks —
 * the way a real stream delivers them, and the reason the loop assembles by index.
 */
export function toolTurn(id: string, name: string, args: Record<string, unknown>): ScriptedTurn {
  const json = JSON.stringify(args);
  return [
    { toolCallDeltas: [{ index: 0, id, name }] },
    { toolCallDeltas: [{ index: 0, argumentsDelta: json.slice(0, 3) }] },
    { toolCallDeltas: [{ index: 0, argumentsDelta: json.slice(3) }] },
    { finishReason: 'tool_calls' },
  ];
}

export const testAgent: AgentDefinition = {
  name: 'assistant',
  systemPrompt: 'You are a test agent.',
  model: 'default-chat',
  toolNames: ['calculator'],
  memory: { scope: (ctx) => `org:${ctx.principal.tenantId}` },
};

export const testStrategy: StrategyDefinition = {
  name: 'semantic',
  purpose: 'Standalone facts that stay true across conversations',
  extractionPrompt: 'Extract durable, standalone facts about the user.',
  topK: 3,
  // Calibrated against Cohere Embed Multilingual v3 — see docs/adr/0003.
  minScore: 0.28,
  halfLifeDays: 180,
};

export interface HarnessFixture {
  module: TestingModule;
  llm: FakeLlmGateway;
  pool: Pool;
  close(): Promise<void>;
}

/** Boots the harness against the test Postgres with a fake gateway bound. */
export async function buildHarness(
  overrides: {
    agents?: AgentDefinition[];
    strategies?: StrategyDefinition[];
    tools?: ToolFactory[];
    chat?: HarnessConfig['chat'];
    memoryStore?: HarnessConfig['memoryStore'];
    llm?: FakeLlmGateway;
    /** Replaces the runtime the way a host would: one DI binding. */
    runtime?: AgentRuntime;
  } = {},
): Promise<HarnessFixture> {
  const pool = createPool({
    connectionString: process.env.DATABASE_URL!,
    lockTimeoutMs: 5_000,
    statementTimeoutMs: 15_000,
    max: 5,
  });
  const llm = overrides.llm ?? new FakeLlmGateway();

  const builder = Test.createTestingModule({
    imports: [
      AiHarnessModule.forRoot({
        db: { pool, schema: 'ai' },
        llm: {
          baseUrl: 'http://litellm.invalid',
          apiKey: 'test',
          chatModel: 'default-chat',
          embedModel: 'default-embed',
          embedDimensions: EMBED_DIMENSIONS,
        },
        agents: overrides.agents ?? [testAgent],
        strategies: overrides.strategies ?? [testStrategy],
        tools: overrides.tools ?? [calculatorTool],
        chat: overrides.chat ?? { replayWindow: 8, consolidateAfterMessages: 2 },
        ...(overrides.memoryStore && { memoryStore: overrides.memoryStore }),
      }),
    ],
  })
    .overrideProvider(LLM_GATEWAY)
    .useValue(llm);

  if (overrides.runtime) builder.overrideProvider(AGENT_RUNTIME).useValue(overrides.runtime);
  const module = await builder.compile();

  return {
    module,
    llm,
    pool,
    close: async () => {
      await module.close();
      await pool.end();
    },
  };
}

/** Creates a session row directly, for tests that are not about the chat turn. */
export async function seedSession(
  pool: Pool,
  owner: { tenantId: string; ownerUserId: string },
  agentName = 'assistant',
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ai.chat_sessions (agent_name, tenant_id, owner_user_id) VALUES ($1, $2, $3) RETURNING id`,
    [agentName, owner.tenantId, owner.ownerUserId],
  );
  return rows[0]!.id;
}

export const ORG_A = '11111111-1111-1111-1111-111111111111';
export const ORG_B = '22222222-2222-2222-2222-222222222222';
export const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
