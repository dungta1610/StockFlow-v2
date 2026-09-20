import { Inject, Injectable, Logger } from '@nestjs/common';
import { LLM_GATEWAY, MEMORY_STORE } from '../config/harness-config';
import type { ChatMessage, StrategyDefinition } from '../config/types';
import type { LlmGateway } from '../llm/llm-gateway.interface';
import type { MemoryRecord, MemoryStore } from './memory-store.interface';
import { RetrievalService } from './retrieval.service';

/** What one strategy pass did. */
export interface StrategyOutcome {
  strategy: string;
  added: MemoryRecord[];
  superseded: number[];
  skipped: number;
}

/**
 * Beyond this similarity a candidate is close enough to something stored that it
 * needs adjudicating. Below it the candidate is plainly new and is written
 * without spending an LLM call.
 *
 * Measured, not guessed: two directly contradicting statements about the same
 * subject ("only drinks black coffee" vs "quit coffee, drinks green tea") sit
 * around 0.5, so a floor of 0.7 silently skipped exactly the conflicts this
 * exists to catch. It can afford to be generous because adjudication is one
 * batched call however many candidates qualify — its only job is to skip the call
 * when nothing is related at all.
 */
const ADJUDICATE_SIMILARITY = 0.45;

/**
 * Neighbours shown to the model per candidate. They span two namespaces — the
 * strategy's own and the bare scope — and the same fact often exists in both, so
 * a few slots go to duplicates of each other.
 */
const NEIGHBOURS_PER_CANDIDATE = 4;

/** Guard against a strategy returning an unbounded list. */
const MAX_CANDIDATES = 8;

/** Transcript budget per extraction pass, in characters. */
const TRANSCRIPT_BUDGET = 6_000;

/**
 * Turns conversations into long-term memory.
 *
 * Each enabled strategy runs its own extraction pass into its own namespace, then
 * every candidate is reconciled against what is already stored, so a fact that
 * changed replaces the old one instead of coexisting with it.
 */
@Injectable()
export class ConsolidationService {
  private readonly logger = new Logger('Consolidation');

  constructor(
    @Inject(LLM_GATEWAY) private readonly llm: LlmGateway,
    @Inject(MEMORY_STORE) private readonly store: MemoryStore,
  ) {}

  /** Run every strategy over a transcript, in parallel, and write the results. */
  async consolidate(input: {
    scope: string;
    strategies: StrategyDefinition[];
    transcript: ChatMessage[];
    sessionId?: string;
  }): Promise<StrategyOutcome[]> {
    const transcript = formatTranscript(input.transcript);
    if (transcript.length === 0) return [];

    // Strategies are independent, so cost is the only thing that scales with how
    // many are enabled — wall-clock stays roughly one pass.
    const outcomes = await Promise.all(
      input.strategies.map((strategy) =>
        this.runStrategy(strategy, transcript, input.scope, input.sessionId),
      ),
    );
    return outcomes.filter((o): o is StrategyOutcome => o !== null);
  }

  private async runStrategy(
    strategy: StrategyDefinition,
    transcript: string,
    scope: string,
    sessionId?: string,
  ): Promise<StrategyOutcome | null> {
    const namespace = RetrievalService.namespaceFor(scope, strategy.name);
    try {
      const candidates = await this.extract(strategy, transcript);
      if (candidates.length === 0) return null;
      return await this.reconcile(strategy, scope, namespace, candidates, sessionId);
    } catch (err) {
      // Consolidation is a background improvement, never a reason to fail a chat.
      this.logger.warn(`Strategy "${strategy.name}" failed: ${message(err)}`);
      return null;
    }
  }

  /** One LLM pass: transcript in, candidate memories out. */
  private async extract(strategy: StrategyDefinition, transcript: string): Promise<Candidate[]> {
    const prompt = [
      strategy.extractionPrompt,
      '',
      'Respond with JSON only, in exactly this shape:',
      '{"memories":[{"content":"...","importance":0.5}]}',
      '',
      '"importance" is between 0 and 1: how much this should influence future',
      'answers. If there is nothing worth remembering, respond {"memories":[]}.',
      '',
      'Conversation:',
      transcript,
    ].join('\n');

    const parsed = parseJsonObject<{ memories?: unknown }>(await this.llm.complete(prompt, { maxTokens: 800 }));
    if (!parsed || !Array.isArray(parsed.memories)) return [];

    return parsed.memories
      .flatMap((entry) => {
        const item = entry as { content?: unknown; importance?: unknown };
        if (typeof item.content !== 'string') return [];
        const content = item.content.trim();
        return content.length === 0 ? [] : [{ content, importance: clamp01(item.importance) }];
      })
      .slice(0, MAX_CANDIDATES);
  }

  /**
   * Decide, for each candidate, whether it is new, replaces something, or is
   * already known — then apply that.
   */
  private async reconcile(
    strategy: StrategyDefinition,
    scope: string,
    namespace: string,
    candidates: Candidate[],
    sessionId?: string,
  ): Promise<StrategyOutcome> {
    // A candidate is written to its strategy namespace, but it can contradict a
    // memory written straight to the bare scope — which retrieval reads too.
    // Adjudicating against both is what allows such a memory to ever be
    // corrected; judged against the strategy namespace alone it would keep being
    // recalled as fact forever, outliving the correction that replaced it.
    //
    // The rule this encodes: any namespace on the read path must also be on the
    // adjudication path. Add one to `recall` and it belongs here too.
    const adjudicateAgainst = [scope, namespace];

    const withNeighbours = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        neighbours: await this.store.neighbours(adjudicateAgainst, candidate.content, NEIGHBOURS_PER_CANDIDATE),
      })),
    );

    // Only candidates near something existing need the model's judgement.
    const contested = withNeighbours.filter((entry) =>
      entry.neighbours.some((n) => (n.score ?? 0) >= ADJUDICATE_SIMILARITY),
    );
    const decisions = await this.adjudicate(contested);

    const outcome: StrategyOutcome = { strategy: strategy.name, added: [], superseded: [], skipped: 0 };

    for (const entry of withNeighbours) {
      const decision = decisions.get(entry.candidate.content) ?? { action: 'add' as const };
      if (decision.action === 'skip') {
        outcome.skipped++;
        continue;
      }
      if (decision.action === 'replace' && decision.replaces?.length) {
        // Only ids the model was actually shown, and only in the namespaces this
        // pass adjudicated against — the store re-checks the second half anyway.
        const known = new Set(entry.neighbours.map((n) => n.id));
        const ids = decision.replaces.filter((id) => known.has(id));
        if (ids.length > 0) {
          // Keep the old rows for audit; they just stop being retrievable.
          await this.store.supersede(adjudicateAgainst, ids);
          outcome.superseded.push(...ids);
        }
      }
      outcome.added.push(
        await this.store.upsert({
          namespace,
          content: entry.candidate.content,
          importance: entry.candidate.importance,
          ...(sessionId && { sourceSessionId: sessionId }),
          metadata: { strategy: strategy.name },
        }),
      );
    }

    this.logger.log(
      `"${namespace}": +${outcome.added.length} ~${outcome.superseded.length} skip ${outcome.skipped}`,
    );
    return outcome;
  }

  /**
   * One batched LLM call for every contested candidate. Batching matters: a
   * per-candidate call would multiply background cost by the number of facts
   * extracted from a single turn.
   */
  private async adjudicate(
    contested: Array<{ candidate: Candidate; neighbours: MemoryRecord[] }>,
  ): Promise<Map<string, Decision>> {
    const decisions = new Map<string, Decision>();
    if (contested.length === 0) return decisions;

    const blocks = contested.map((entry, index) =>
      [
        `  candidate ${index}: ${entry.candidate.content}`,
        '  existing memories:',
        entry.neighbours.map((n) => `    - id ${n.id}: ${n.content}`).join('\n'),
      ].join('\n'),
    );

    const prompt = [
      'You maintain the long-term memory an assistant keeps about ONE user. Every',
      "memory below belongs to that same user's profile, however it is worded.",
      'Each was written to stand on its own, so the user is usually named instead',
      'of being called "the user" — two memories naming different people are still',
      'both about them, unless a memory plainly describes somebody else such as a',
      'colleague or a family member.',
      '',
      'For each candidate, decide how it relates to the memories listed under it.',
      '',
      '- "add": genuinely new information.',
      '- "replace": it contradicts or updates existing memories. A profile holds',
      '  one value per attribute, so a candidate stating a different name, job,',
      '  employer, location or habit for the user makes the old memory obsolete —',
      '  it does not describe a second person. List the ids it makes obsolete in',
      '  "replaces".',
      '- "skip": already fully covered by an existing memory.',
      '',
      'Respond with JSON only:',
      '{"decisions":[{"candidate":0,"action":"add","replaces":[]}]}',
      '',
      ...blocks,
    ].join('\n');

    const parsed = parseJsonObject<{ decisions?: unknown }>(await this.llm.complete(prompt, { maxTokens: 600 }));
    if (!parsed || !Array.isArray(parsed.decisions)) return decisions;

    for (const entry of parsed.decisions) {
      const item = entry as { candidate?: unknown; action?: unknown; replaces?: unknown };
      const target = contested[typeof item.candidate === 'number' ? item.candidate : -1];
      if (!target) continue;

      const action = item.action === 'replace' || item.action === 'skip' ? item.action : 'add';
      const replaces = Array.isArray(item.replaces)
        ? item.replaces.filter((id): id is number => typeof id === 'number')
        : [];
      decisions.set(target.candidate.content, { action, replaces });
    }
    return decisions;
  }
}

interface Candidate {
  content: string;
  importance: number;
}

interface Decision {
  action: 'add' | 'replace' | 'skip';
  replaces?: number[];
}

/** Cap the transcript from the end: recent turns are what a pass should judge. */
function formatTranscript(turns: ChatMessage[]): string {
  const transcript = turns.map((t) => `${t.role}: ${t.content}`).join('\n');
  return (transcript.length > TRANSCRIPT_BUDGET ? transcript.slice(-TRANSCRIPT_BUDGET) : transcript).trim();
}

/**
 * Pull the first JSON object out of a completion. Models wrap JSON in prose or
 * fences even when told not to, and `response_format` is not dependable across
 * the providers LiteLLM fronts — so parse defensively instead of relying on it.
 */
function parseJsonObject<T>(raw: string): T | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function clamp01(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.5;
  return Math.min(Math.max(value, 0), 1);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
