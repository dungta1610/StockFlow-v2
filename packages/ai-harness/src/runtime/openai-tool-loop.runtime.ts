import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { HARNESS_CONFIG, LLM_GATEWAY, type ResolvedHarnessConfig } from '../config/harness-config';
import type { AgentDefinition, RunEvent, RunInput, RunResult, ToolCallRecord, ToolDefinition } from '../config/types';
import type { LlmGateway } from '../llm/llm-gateway.interface';
import type { ProtocolMessage, ToolCall, ToolSchema } from '../llm/llm.types';
import type { AgentRuntime } from './agent-runtime.interface';

/** Tool output handed back to the model, capped so one chatty tool cannot fill the context. */
const MAX_TOOL_RESULT_CHARS = 8_000;

/**
 * The agent loop, written against the OpenAI tool-calling protocol that LiteLLM
 * serves for every provider behind it.
 *
 * It exists instead of an SDK agent because of one requirement: the application
 * shows the user which tool ran and for how long. An SDK that yields only text
 * deltas cannot provide that, and no amount of wrapping adds information the
 * stream never carried. Here the loop calls the handlers itself, so `tool_start`
 * and `tool_end` are facts it observes rather than events it hopes to receive.
 */
@Injectable()
export class OpenAiToolLoopRuntime implements AgentRuntime {
  private readonly logger = new Logger('AgentRuntime');

  constructor(
    @Inject(LLM_GATEWAY) private readonly llm: LlmGateway,
    @Inject(HARNESS_CONFIG) private readonly config: ResolvedHarnessConfig,
  ) {}

  async run(input: RunInput): Promise<RunResult> {
    let text = '';
    const toolCalls: ToolCallRecord[] = [];
    for await (const event of this.stream(input, toolCalls)) {
      if (event.type === 'text') text += event.delta;
      if (event.type === 'error') throw new Error(event.message);
    }
    return { text, toolCalls };
  }

  /**
   * `collected` lets `run` see the tool records without the stream having to
   * carry a terminal event that streaming consumers would have to ignore.
   */
  async *stream(input: RunInput, collected: ToolCallRecord[] = []): AsyncIterable<RunEvent> {
    const agent = this.agent(input.agentName);
    const byName = new Map(input.tools.map((t) => [t.name, t]));
    const schemas = input.tools.map(toToolSchema);
    const messages = openingMessages(agent, input);

    try {
      const maxRounds = this.config.chat.maxToolRounds;
      for (let iteration = 0; iteration < maxRounds; iteration++) {
        const turn = { text: '', calls: new Map<number, PartialCall>() };

        for await (const chunk of this.llm.streamChat({
          model: agent.model,
          messages,
          ...(schemas.length > 0 && { tools: schemas }),
        })) {
          if (chunk.textDelta) {
            turn.text += chunk.textDelta;
            yield { type: 'text', delta: chunk.textDelta };
          }
          for (const delta of chunk.toolCallDeltas ?? []) {
            const call = turn.calls.get(delta.index) ?? { id: '', name: '', arguments: '' };
            if (delta.id) call.id = delta.id;
            if (delta.name) call.name = delta.name;
            if (delta.argumentsDelta) call.arguments += delta.argumentsDelta;
            turn.calls.set(delta.index, call);
          }
        }

        const requested = [...turn.calls.values()].filter((c) => c.name.length > 0);
        if (requested.length === 0) return;

        // The model's own turn has to go back verbatim, tool calls included, or
        // the tool results that follow reference ids in no preceding message.
        messages.push({
          role: 'assistant',
          content: turn.text.length > 0 ? turn.text : null,
          toolCalls: requested.map(toToolCall),
        });

        for (const call of requested) {
          const id = call.id || `${call.name}-${iteration}`;
          const tool = byName.get(call.name);
          const parsed = parseArguments(call.arguments);

          yield { type: 'tool_start', callId: id, name: call.name, input: parsed };
          const started = Date.now();
          const outcome = tool
            ? await invoke(tool, parsed)
            : { ok: false as const, output: `Unknown tool "${call.name}".` };
          // Never less than 1ms: a handler that returns immediately still ran, and
          // a duration of 0 reads as "no measurement" to anything downstream.
          const durationMs = Math.max(Date.now() - started, 1);

          const record: ToolCallRecord = {
            callId: id,
            name: call.name,
            input: parsed,
            ok: outcome.ok,
            durationMs,
            ...(outcome.ok ? {} : { error: outcome.output }),
          };
          collected.push(record);
          yield {
            type: 'tool_end',
            callId: id,
            name: call.name,
            ok: outcome.ok,
            durationMs,
            ...(outcome.ok ? {} : { error: outcome.output }),
          };

          // A failed tool is reported to the model rather than thrown: it can
          // apologise, retry with different arguments, or answer without the tool.
          messages.push({
            role: 'tool',
            toolCallId: id,
            content: outcome.output.slice(0, MAX_TOOL_RESULT_CHARS),
          });
        }
      }

      // A controlled stop, not a hang: whatever text was already streamed stands,
      // and the caller is told the turn ran out of rounds rather than left waiting.
      yield { type: 'error', message: `Agent stopped after ${maxRounds} tool rounds without answering.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Run of agent "${input.agentName}" failed: ${message}`);
      yield { type: 'error', message };
    }
  }

  private agent(name: string): AgentDefinition {
    const agent = this.config.agents.find((a) => a.name === name);
    if (!agent) {
      const known = this.config.agents.map((a) => a.name).join(', ');
      throw new Error(`Unknown agent "${name}". Registered: ${known}`);
    }
    return agent;
  }
}

/** A tool call still being assembled from stream deltas. */
interface PartialCall {
  id: string;
  name: string;
  arguments: string;
}

function toToolCall(call: PartialCall): ToolCall {
  return { id: call.id, name: call.name, arguments: call.arguments || '{}' };
}

function openingMessages(agent: AgentDefinition, input: RunInput): ProtocolMessage[] {
  const system = input.systemPromptExtra
    ? `${agent.systemPrompt}\n\n${input.systemPromptExtra}`
    : agent.systemPrompt;
  return [
    { role: 'system', content: system },
    ...(input.history ?? []).map((m): ProtocolMessage =>
      m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content },
    ),
    { role: 'user', content: input.input },
  ];
}

/** Our tool type → what the model is told, via zod's JSON Schema output. */
function toToolSchema(tool: ToolDefinition): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown>,
  };
}

/** Models emit `{}`, empty strings and occasionally prose; none of that may throw. */
function parseArguments(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Validate, then run. A schema violation is reported to the model exactly like a
 * handler failure, because from the loop's point of view it is one: the call did
 * not produce a usable result, and the model is the thing that can fix it.
 */
async function invoke(
  tool: ToolDefinition,
  input: unknown,
): Promise<{ ok: true; output: string } | { ok: false; output: string }> {
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, output: `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}` };
  }
  try {
    const result = await tool.handler(parsed.data);
    return { ok: true, output: typeof result === 'string' ? result : JSON.stringify(result) };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}
