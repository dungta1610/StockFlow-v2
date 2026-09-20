import { Inject, Injectable } from '@nestjs/common';
import type { ChatMessage, StrategyDefinition } from '../config/types';
import { MEMORY_STORE } from '../config/harness-config';
import type { MemoryRecord, MemoryStore } from './memory-store.interface';
import { jaccard, tokenize } from './text-similarity';

/** Memories found for one strategy. */
export interface RecallGroup {
  strategy: string;
  purpose: string;
  hits: MemoryRecord[];
}

/**
 * A message this short is unlikely to be self-contained ("and the other one?"),
 * so the previous user turn is folded into the retrieval query. Long messages are
 * left alone: padding a good query with unrelated text only blurs the vector.
 */
const SHORT_QUERY_WORDS = 8;

/** How much a returned memory may overlap another before it is dropped. */
const MAX_OVERLAP = 0.8;

/** Retrieval settings for memories written straight to the bare scope. */
const BARE_SCOPE_RETRIEVAL = { topK: 3, minScore: 0.28 };

/**
 * Reads long-term memory for one turn.
 *
 * Each strategy is queried in its own namespace with its own floor and half-life,
 * because a stable fact and a preference should not be ranked the same way. The
 * bare scope is queried too, so a memory written directly still surfaces
 * alongside extracted ones — and consolidation adjudicates against that same set,
 * which is the only reason such a memory can ever be corrected.
 */
@Injectable()
export class RetrievalService {
  constructor(@Inject(MEMORY_STORE) private readonly store: MemoryStore) {}

  /** Namespace a strategy writes to for a scope. */
  static namespaceFor(scope: string, strategy: string): string {
    return `${scope}:${strategy}`;
  }

  async recall(input: {
    scope: string;
    strategies: StrategyDefinition[];
    latest: string;
    history?: ChatMessage[];
  }): Promise<RecallGroup[]> {
    const query = buildQuery(input.latest, input.history);

    const [bare, ...perStrategy] = await Promise.all([
      this.store.search([input.scope], query, { ...BARE_SCOPE_RETRIEVAL, maxOverlap: MAX_OVERLAP }),
      ...input.strategies.map((strategy) =>
        this.store.search([RetrievalService.namespaceFor(input.scope, strategy.name)], query, {
          topK: strategy.topK,
          minScore: strategy.minScore,
          ...(strategy.halfLifeDays !== undefined && { halfLifeDays: strategy.halfLifeDays }),
          maxOverlap: MAX_OVERLAP,
        }),
      ),
    ]);

    const groups: RecallGroup[] = [];
    if (bare && bare.length > 0) {
      groups.push({ strategy: 'direct', purpose: 'Written directly', hits: bare });
    }
    input.strategies.forEach((strategy, index) => {
      const hits = perStrategy[index];
      if (hits && hits.length > 0) {
        groups.push({ strategy: strategy.name, purpose: strategy.purpose ?? strategy.name, hits });
      }
    });

    return deduplicateAcrossGroups(groups);
  }

  /** Render recalled memory as a block to append to a system prompt. */
  format(groups: RecallGroup[]): string {
    if (groups.length === 0) return '';
    return groups
      .map((group) => `${group.purpose}:\n${group.hits.map((hit) => `- ${hit.content}`).join('\n')}`)
      .join('\n\n');
  }
}

/**
 * Drop a memory a previous group already contributed.
 *
 * Each namespace is deduplicated on its own inside the store, which cannot see
 * across them — and the same fact really does end up in two namespaces: recall
 * injects a directly-written memory into the prompt, extraction then reads it
 * back out of the transcript and files it under a strategy. Left alone, the agent
 * would be told the same thing twice out of one prompt budget.
 */
function deduplicateAcrossGroups(groups: RecallGroup[]): RecallGroup[] {
  const seen: Set<string>[] = [];
  return groups
    .map((group) => ({
      ...group,
      hits: group.hits.filter((hit) => {
        const tokens = tokenize(hit.content);
        if (seen.some((prior) => jaccard(tokens, prior) > MAX_OVERLAP)) return false;
        seen.push(tokens);
        return true;
      }),
    }))
    .filter((group) => group.hits.length > 0);
}

/**
 * The text to embed. Retrieving on the raw last message loses the thread the
 * moment a user says something anaphoric, so short messages inherit the previous
 * user turn as context.
 */
function buildQuery(latest: string, history?: ChatMessage[]): string {
  const words = latest.trim().split(/\s+/).filter(Boolean);
  if (words.length >= SHORT_QUERY_WORDS || !history) return latest;

  const previousUserTurn = [...history].reverse().find((t) => t.role === 'user' && t.content !== latest);
  return previousUserTurn ? `${previousUserTurn.content}\n${latest}` : latest;
}
