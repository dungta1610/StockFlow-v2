/**
 * The wire shapes of the OpenAI-compatible chat API, which is what LiteLLM serves
 * whatever provider sits behind it. They are modelled explicitly rather than
 * imported from a vendor SDK: the tool loop has to build assistant/tool messages
 * by hand, and a type it cannot see the shape of is a type it cannot debug.
 */

/** A tool as the model is told about it. */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
}

/** One tool call the model asked for, fully assembled. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text; the model is free to emit something unparseable. */
  arguments: string;
}

export type ProtocolMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ChatRequest {
  model: string;
  messages: ProtocolMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
}

/**
 * One streamed chunk. Tool calls arrive split across chunks and indexed by
 * position, not by id — the id itself turns up in a later chunk than the first
 * fragment of its arguments — so the loop assembles them by `index`.
 */
export interface ChatStreamChunk {
  textDelta?: string;
  toolCallDeltas?: Array<{
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  }>;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * Cohere Embed v3 is asymmetric: the same text embeds differently depending on
 * whether it is being stored or searched with, and comparing a query vector
 * against document vectors is what the model is trained for. Sending one input
 * type for both halves measurably weakens retrieval.
 */
export type EmbeddingPurpose = 'document' | 'query';

export const INPUT_TYPE: Record<EmbeddingPurpose, string> = {
  document: 'search_document',
  query: 'search_query',
};
