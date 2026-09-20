import type { ZodType } from 'zod';

/**
 * Who and what a run belongs to.
 *
 * `tenantId` is how tenancy travels through a package that has no idea what a
 * tenant *is*: the application passes its organisation id in, and the harness only
 * ever uses it to build a memory namespace and to stamp session ownership. Nothing
 * here interprets it.
 */
export interface RunContext {
  sessionId: string;
  principal: { id: string; tenantId: string };
}

/** One conversation turn, as history and transcripts carry it. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** What one tool call did, recorded on the result of a run. */
export interface ToolCallRecord {
  callId: string;
  name: string;
  input: unknown;
  ok: boolean;
  durationMs: number;
  /** Present when the call failed. */
  error?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Everything one run of an agent needs. */
export interface RunInput {
  agentName: string;
  input: string;
  context: RunContext;
  history?: ChatMessage[];
  /**
   * Built for this request from the tool factories, never taken from a static
   * registry: a tool closes over the caller, so two callers must not share one.
   */
  tools: ToolDefinition[];
  /** Where retrieval injects recalled memory and the running session summary. */
  systemPromptExtra?: string;
}

export interface RunResult {
  text: string;
  toolCalls: ToolCallRecord[];
  usage?: TokenUsage;
}

/**
 * What a run emits as it happens.
 *
 * `tool_start`/`tool_end` are the reason this union exists. The runtime emits them
 * itself around every handler rather than forwarding whatever the model SDK
 * happens to expose, so the events are guaranteed to be there and to carry a
 * duration — an SDK that only yields text deltas cannot take them away.
 */
export type RunEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; callId: string; name: string; input: unknown }
  | { type: 'tool_end'; callId: string; name: string; ok: boolean; durationMs: number; error?: string }
  | { type: 'error'; message: string };

/**
 * A tool as the harness defines it — deliberately not the model SDK's tool type.
 * Adapting to whatever the runtime needs happens inside the runtime, which is the
 * condition for a runtime being swappable at all.
 */
export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
  schema: ZodType<I>;
  handler: (input: I) => Promise<unknown>;
}

/**
 * Builds a tool for one request. The factory receives the run context, so a tool
 * can close over the caller and enforce their scope instead of trusting arguments
 * the model chose.
 *
 * The name is on the factory as well as on what it builds, so a registry can list
 * and resolve tools without constructing one against a fabricated context.
 */
export interface ToolFactory {
  (ctx: RunContext): ToolDefinition;
  readonly toolName: string;
}

/** Pairs a factory with the name of the tool it builds. */
export function toolFactory(name: string, build: (ctx: RunContext) => ToolDefinition): ToolFactory {
  return Object.assign(build, { toolName: name });
}

/**
 * Declares a tool whose handler is typed by its own schema.
 *
 * A registry holds tools of many different argument types, so it can only store
 * them as `ToolDefinition<unknown>` — and a handler that accepts a specific shape
 * is not assignable to one that accepts anything. This is the single place that
 * widening happens, and it is sound because the only caller of a handler is the
 * runtime, which parses the arguments against `schema` before it calls.
 */
export function defineTool<I>(definition: {
  name: string;
  description: string;
  schema: ZodType<I>;
  handler: (input: I) => Promise<unknown>;
}): ToolDefinition {
  return definition as unknown as ToolDefinition;
}

/** An agent, declared as data. */
export interface AgentDefinition {
  name: string;
  systemPrompt: string;
  model: string;
  toolNames: string[];
  /** Omit for an agent that neither recalls nor forms memory. */
  memory?: {
    /**
     * A function, not a string: the namespace depends on who is asking, and a
     * static scope would put two tenants' memories in the same bucket.
     */
    scope: (ctx: RunContext) => string;
    /** Strategy names; omit for every strategy the host registered. */
    strategies?: string[];
  };
}

/** One extraction pass: a prompt, a namespace suffix, and how retrieval reads it. */
export interface StrategyDefinition {
  name: string;
  /** What this pass should pull out of a transcript; the JSON contract is added around it. */
  extractionPrompt: string;
  topK: number;
  /** Cosine floor. A hit below it survives only if it also matched lexically. */
  minScore: number;
  /** One line describing the pass, used as the heading of its recalled block. */
  purpose?: string;
  /** Days for the recency weight to halve. Omit to rank without recency. */
  halfLifeDays?: number;
}
