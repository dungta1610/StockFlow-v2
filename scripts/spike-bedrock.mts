// Bedrock / LiteLLM spike — answers the three questions the AI phases depend on
// before any of that work starts (see docs/adr/0003):
//   (a) does the chat alias answer?
//   (b) how many dimensions does the embedding alias return?
//   (c) does a real tool call surface observable lifecycle events on agent.stream()?
//
// Prerequisites: AWS_* in .env, then `docker compose up -d litellm`.
// Usage: pnpm spike:bedrock
import 'dotenv/config';
import { Agent, tool } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import OpenAI from 'openai';
import { z } from 'zod';

const baseURL = `${process.env.LITELLM_BASE_URL ?? 'http://localhost:4001'}/v1`;
const apiKey = process.env.LITELLM_API_KEY ?? 'sk-stockflow-dev-change-me';

const hasCreds =
  Boolean(process.env.AWS_BEARER_TOKEN_BEDROCK) ||
  Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
if (!hasCreds) {
  console.error(
    'No AWS credentials: set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY or AWS_BEARER_TOKEN_BEDROCK in .env, ' +
      'then `docker compose up -d litellm` and re-run.',
  );
  process.exit(2);
}

const client = new OpenAI({ baseURL, apiKey });

async function chat(): Promise<string> {
  const res = await client.chat.completions.create({
    model: 'default-chat',
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
    max_tokens: 10,
  });
  return res.choices[0]?.message?.content ?? '';
}

async function embeddingDimension(): Promise<number> {
  const res = await client.embeddings.create({
    model: 'default-embed',
    input: ['kiểm tra tồn kho'],
    // Cohere is asymmetric; LiteLLM forwards input_type to Bedrock.
    // @ts-expect-error provider-specific passthrough
    input_type: 'search_document',
  });
  return res.data[0]?.embedding.length ?? 0;
}

async function toolEvents(): Promise<{ types: string[]; answer: string; toolCalled: boolean }> {
  let toolCalled = false;
  const add = tool({
    name: 'add',
    description: 'Add two integers.',
    inputSchema: z.object({ a: z.number().int(), b: z.number().int() }),
    callback: ({ a, b }) => {
      toolCalled = true;
      return String(a + b);
    },
  });

  const agent = new Agent({
    model: new OpenAIModel({ api: 'chat', apiKey, clientConfig: { baseURL }, modelId: 'default-chat' }),
    tools: [add],
    systemPrompt: 'Always use the add tool for arithmetic. Answer with the number only.',
    printer: false,
  });

  const types = new Set<string>();
  let answer = '';
  for await (const event of agent.stream('What is 1234 + 4321?')) {
    const e = event as { type?: string; event?: { type?: string; delta?: { type?: string; text?: string } } };
    types.add(e.type ?? '(no type)');
    if (e.event?.type) types.add(`  inner:${e.event.type}`);
    if (e.event?.delta?.type) types.add(`  delta:${e.event.delta.type}`);
    if (e.event?.delta?.type === 'textDelta' && e.event.delta.text) answer += e.event.delta.text;
    // Raw dump of anything tool-related so its exact shape can be mapped later.
    if (/tool/i.test(JSON.stringify(e).slice(0, 200))) {
      console.log('  tool-ish event:', JSON.stringify(e).slice(0, 300));
    }
  }
  return { types: [...types].sort(), answer: answer.trim(), toolCalled };
}

async function main() {
  const out: Record<string, unknown> = { baseURL };

  out.chat = await chat();
  console.log(`(a) chat -> ${JSON.stringify(out.chat)}`);

  out.embeddingDimension = await embeddingDimension();
  console.log(`(b) embedding dimension -> ${out.embeddingDimension}`);

  const t = await toolEvents();
  out.toolEvents = t;
  const lifecycle = t.types.some((x) => /toolcall|tooluse|toolresult/i.test(x));
  console.log(`(c) tool called: ${t.toolCalled}; answer: ${t.answer}`);
  console.log(`    stream event types:\n    ${t.types.join('\n    ')}`);
  console.log(
    `    VERDICT: ${lifecycle ? 'tool lifecycle events ARE observable on agent.stream()' : 'NO tool lifecycle events on agent.stream() — Phase 07 needs its own tool loop'}`,
  );

  console.log('\nSUMMARY ' + JSON.stringify(out));
}

main().catch((err: unknown) => {
  console.error('spike failed:', (err as Error).message);
  process.exit(1);
});
