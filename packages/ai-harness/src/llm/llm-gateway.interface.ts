import type { ChatRequest, ChatStreamChunk, EmbeddingPurpose } from './llm.types';

/**
 * The only way out of the harness to a model provider.
 *
 * Three methods because there are three genuinely different needs: a streaming
 * loop that can call tools, a one-shot completion for background extraction
 * passes, and embeddings. Tests bind a fake here, which is why no test in this
 * package needs a network or a credential.
 */
export interface LlmGateway {
  streamChat(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
  complete(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; model?: string },
  ): Promise<string>;
  embed(text: string, purpose: EmbeddingPurpose): Promise<number[]>;
}
