import { Inject, Injectable } from '@nestjs/common';
import { HARNESS_CONFIG, type ResolvedHarnessConfig } from '../config/harness-config';
import type { LlmGateway } from './llm-gateway.interface';
import {
  INPUT_TYPE,
  type ChatRequest,
  type ChatStreamChunk,
  type EmbeddingPurpose,
  type ProtocolMessage,
} from './llm.types';

/** The slice of an OpenAI streaming chunk this gateway reads. */
interface WireStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * Talks to LiteLLM's OpenAI-compatible endpoints over plain fetch.
 *
 * Which real provider answers is decided in LiteLLM config, never here — that is
 * the whole point of routing through it. Written against the wire protocol rather
 * than a vendor SDK so the tool loop owns the message protocol it depends on.
 */
@Injectable()
export class LiteLlmGateway implements LlmGateway {
  constructor(@Inject(HARNESS_CONFIG) private readonly config: ResolvedHarnessConfig) {}

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const res = await this.post('/v1/chat/completions', {
      model: request.model,
      messages: request.messages.map(toWireMessage),
      ...(request.tools?.length && {
        tools: request.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }),
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 1024,
      stream: true,
      stream_options: { include_usage: true },
    });

    for await (const data of readServerSentEvents(res)) {
      const chunk = JSON.parse(data) as WireStreamChunk;
      const choice = chunk.choices?.[0];
      const out: ChatStreamChunk = {};
      if (choice?.delta?.content) out.textDelta = choice.delta.content;
      if (choice?.delta?.tool_calls?.length) {
        out.toolCallDeltas = choice.delta.tool_calls.map((c) => ({
          index: c.index,
          ...(c.id && { id: c.id }),
          ...(c.function?.name && { name: c.function.name }),
          ...(c.function?.arguments && { argumentsDelta: c.function.arguments }),
        }));
      }
      if (choice?.finish_reason) out.finishReason = choice.finish_reason;
      if (chunk.usage) {
        out.usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      if (Object.keys(out).length > 0) yield out;
    }
  }

  async complete(
    prompt: string,
    options: { maxTokens?: number; temperature?: number; model?: string } = {},
  ): Promise<string> {
    const res = await this.post('/v1/chat/completions', {
      model: options.model ?? this.config.llm.chatModel,
      messages: [{ role: 'user', content: prompt }],
      // Extraction and summarisation should be repeatable, not creative.
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 1024,
    });
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? '';
  }

  async embed(text: string, purpose: EmbeddingPurpose): Promise<number[]> {
    const res = await this.post('/v1/embeddings', {
      model: this.config.llm.embedModel,
      input: text,
      // Ignored by providers with no notion of input type; LiteLLM runs with
      // drop_params, so an unsupported field is not an error.
      input_type: INPUT_TYPE[purpose],
    });
    const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vector = body.data?.[0]?.embedding;
    if (!vector || vector.length === 0) throw new Error('Embedding response contained no vector.');
    return vector;
  }

  private async post(path: string, payload: unknown): Promise<Response> {
    const res = await fetch(`${this.config.llm.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.llm.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`LLM request to ${path} failed: ${res.status} ${await res.text()}`);
    return res;
  }
}

/** Harness message shape → the wire's snake_case tool fields. */
function toWireMessage(message: ProtocolMessage): Record<string, unknown> {
  switch (message.role) {
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length && {
          tool_calls: message.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        }),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    default:
      return { role: message.role, content: message.content };
  }
}

/**
 * Yields the `data:` payloads of an SSE body, stopping at `[DONE]`.
 *
 * Buffered rather than split per read because an event can straddle two network
 * chunks — parsing each read on its own drops exactly the long tool-argument
 * fragments this loop depends on.
 */
async function* readServerSentEvents(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new Error('Streaming response had no body.');
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(piece, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (data.length > 0) yield data;
    }
  }
}
