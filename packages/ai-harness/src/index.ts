// Domain-agnostic agent runtime. Nothing here knows what an order, a price or a
// warehouse is; the boundary is enforced by eslint.config.mjs and by
// test/harness/no-domain-import.spec.ts.

export { AiHarnessModule } from './ai-harness.module';
export {
  AGENT_RUNTIME,
  HARNESS_CONFIG,
  LLM_GATEWAY,
  MEMORY_STORE,
  validateHarnessConfig,
  type HarnessConfig,
  type ResolvedHarnessConfig,
} from './config/harness-config';
export { defineTool, toolFactory } from './config/types';
export type {
  AgentDefinition,
  ChatMessage,
  RunContext,
  RunEvent,
  RunInput,
  RunResult,
  StrategyDefinition,
  TokenUsage,
  ToolCallRecord,
  ToolDefinition,
  ToolFactory,
} from './config/types';

export { ChatTurnService, type ChatTurnInput } from './chat/chat-turn.service';
export type { AgentRuntime } from './runtime/agent-runtime.interface';
export { OpenAiToolLoopRuntime } from './runtime/openai-tool-loop.runtime';

export type { LlmGateway } from './llm/llm-gateway.interface';
export { LiteLlmGateway } from './llm/litellm.gateway';
export {
  INPUT_TYPE,
  type ChatRequest,
  type ChatStreamChunk,
  type EmbeddingPurpose,
  type ProtocolMessage,
  type ToolCall,
  type ToolSchema,
} from './llm/llm.types';

export { ConsolidationService, type StrategyOutcome } from './memory/consolidation.service';
export { EmbeddingService } from './memory/embedding.service';
export type { MemoryRecord, MemoryStore, MemoryWrite, SearchOptions } from './memory/memory-store.interface';
export { PgVectorMemoryStore } from './memory/pgvector-memory.store';
export { RetrievalService, type RecallGroup } from './memory/retrieval.service';
export { RRF_K, rrfScore, type BranchRanks } from './memory/rrf';
export { dropNearDuplicates, jaccard, tokenize } from './memory/text-similarity';

export {
  SessionService,
  type ChatSession,
  type ChatSessionSummary,
  type SessionOwner,
  type StoredMessage,
} from './session/session.service';
export { SessionSummaryService, type SessionSummary } from './session/session-summary.service';

export { ToolRegistry } from './tools/tool.registry';
export { calculatorTool } from './tools/builtin/calculator.tool';
export { getTimeTool } from './tools/builtin/get-time.tool';
