import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { HARNESS_CONFIG, LLM_GATEWAY, type ResolvedHarnessConfig } from '../config/harness-config';
import type { LlmGateway } from '../llm/llm-gateway.interface';
import { INPUT_TYPE, type EmbeddingPurpose } from '../llm/llm.types';

/**
 * Turns text into a dense embedding, through a cache keyed on
 * `(content_hash, model, input_type)`.
 *
 * All three parts of that key are load-bearing. The model is obvious. The input
 * type is not: an asymmetric embedding model returns a different vector for the
 * same string depending on whether it is being stored or searched with, so a key
 * without it serves the wrong half of the pair — no error, no warning, just
 * similarity numbers that quietly stop meaning what the score floor was
 * calibrated against.
 *
 * The cache is a table rather than a process-local map because embedding sits on
 * the critical path of every turn and every extraction pass, and a restart should
 * not re-buy vectors that were already paid for.
 */
@Injectable()
export class EmbeddingService {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(
    @Inject(LLM_GATEWAY) private readonly llm: LlmGateway,
    @Inject(HARNESS_CONFIG) private readonly config: ResolvedHarnessConfig,
  ) {
    this.pool = config.db.pool;
    this.schema = config.db.schema;
  }

  async embed(text: string, purpose: EmbeddingPurpose = 'document'): Promise<number[]> {
    const hash = createHash('sha256').update(text).digest('hex');
    const model = this.config.llm.embedModel;
    const inputType = INPUT_TYPE[purpose];

    const { rows } = await this.pool.query<{ embedding: string }>(
      `SELECT embedding FROM ${this.schema}.embedding_cache
        WHERE content_hash = $1 AND model = $2 AND input_type = $3`,
      [hash, model, inputType],
    );
    const cached = rows[0];
    if (cached) return parseVector(cached.embedding);

    const vector = await this.llm.embed(text, purpose);
    if (vector.length !== this.config.llm.embedDimensions) {
      throw new Error(
        `Embedding model returned ${vector.length} dimensions but the harness is ` +
          `configured for ${this.config.llm.embedDimensions}; the memories column cannot store it.`,
      );
    }

    // Concurrent turns embedding the same text race here; either write is correct,
    // so the loser is dropped rather than retried.
    await this.pool.query(
      `INSERT INTO ${this.schema}.embedding_cache (content_hash, model, input_type, embedding)
       VALUES ($1, $2, $3, $4::vector)
       ON CONFLICT (content_hash, model, input_type) DO NOTHING`,
      [hash, model, inputType, toVectorLiteral(vector)],
    );
    return vector;
  }
}

/** pgvector accepts a vector as the literal "[1,2,3]" and returns it the same way. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

function parseVector(literal: string): number[] {
  return literal
    .slice(1, -1)
    .split(',')
    .map((n) => Number(n));
}
