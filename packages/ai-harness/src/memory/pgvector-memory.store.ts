import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { HARNESS_CONFIG, type ResolvedHarnessConfig } from '../config/harness-config';
import { EmbeddingService, toVectorLiteral } from './embedding.service';
import type { MemoryRecord, MemoryStore, MemoryWrite, SearchOptions } from './memory-store.interface';
import { rrfScore, type BranchRanks } from './rrf';
import { dropNearDuplicates } from './text-similarity';

interface MemoryRow {
  id: string; // bigint arrives as a string from pg
  namespace: string;
  content: string;
  metadata: Record<string, unknown>;
  importance: number;
  created_at: Date;
  source_session: string | null;
  score?: number;
  vec_rank?: number | null;
  lex_rank?: number | null;
}

/**
 * Above this cosine similarity a new memory is treated as the same fact as an
 * existing one and collapsed into it instead of inserted again.
 */
const DEDUPE_SIMILARITY = 0.97;

/**
 * Recency never decays a memory to nothing: a stale fact should rank below a
 * fresh one, not become unreachable. Without a floor, "the user's name is X"
 * would sink out of retrieval simply for being old.
 */
const RECENCY_FLOOR = 0.6;

/** Candidates pulled per branch before fusion, filtering and diversification. */
const CANDIDATE_MULTIPLIER = 4;
const MIN_CANDIDATES = 20;

/**
 * pgvector-backed memory.
 *
 * Every statement below filters `namespace = ANY($n)`. That is the rule, not a
 * habit: the boundary between one tenant's memories and another's is a WHERE
 * clause, and a method that takes namespaces but does not use them in its SQL
 * enforces nothing at all.
 */
@Injectable()
export class PgVectorMemoryStore implements MemoryStore {
  private readonly logger = new Logger('MemoryStore');
  private readonly pool: Pool;
  private readonly schema: string;
  /**
   * Hybrid retrieval: a vector branch and a lexical branch, each ranked on its
   * own, fused in TypeScript.
   *
   * The namespace filter is repeated per branch rather than hoisted into a shared
   * CTE on purpose. A CTE referenced more than once is materialised by Postgres,
   * and materialising the candidate set throws away the HNSW index that makes the
   * vector branch fast.
   */
  private readonly hybridSql: string;

  constructor(
    @Inject(HARNESS_CONFIG) config: ResolvedHarnessConfig,
    private readonly embedder: EmbeddingService,
  ) {
    this.pool = config.db.pool;
    this.schema = config.db.schema;
    this.hybridSql = `
WITH vec AS (
  SELECT id, row_number() OVER () AS rnk
  FROM (
    SELECT id FROM ${this.schema}.memories
    WHERE namespace = ANY($1::text[]) AND superseded_at IS NULL
    ORDER BY embedding <=> $2::vector
    LIMIT $4
  ) ranked
),
lex AS (
  SELECT id, row_number() OVER () AS rnk
  FROM (
    SELECT id FROM ${this.schema}.memories
    WHERE namespace = ANY($1::text[]) AND superseded_at IS NULL
      AND content_tsv @@ plainto_tsquery('public.simple_unaccent', $3)
    ORDER BY ts_rank_cd(content_tsv, plainto_tsquery('public.simple_unaccent', $3)) DESC
    LIMIT $4
  ) ranked
)
SELECT m.id, m.namespace, m.content, m.metadata, m.importance, m.created_at, m.source_session,
       1 - (m.embedding <=> $2::vector) AS score,
       vec.rnk::int AS vec_rank,
       lex.rnk::int AS lex_rank
FROM ${this.schema}.memories m
JOIN (SELECT id FROM vec UNION SELECT id FROM lex) hit ON hit.id = m.id
LEFT JOIN vec ON vec.id = m.id
LEFT JOIN lex ON lex.id = m.id
WHERE m.namespace = ANY($1::text[]) AND m.superseded_at IS NULL`;
  }

  async upsert(write: MemoryWrite): Promise<MemoryRecord> {
    const embedding = await this.embedder.embed(write.content, 'document');

    // Collapse an all-but-identical restatement into the row that already holds
    // it, so repeated facts don't accumulate and eat the top-k budget. Scoped to
    // the target namespace only: collapsing into a row somewhere else would
    // return a record this write never made and skip the write entirely.
    const duplicate = (await this.nearest([write.namespace], toVectorLiteral(embedding), 1))[0];
    if (duplicate && (duplicate.score ?? 0) >= DEDUPE_SIMILARITY) {
      this.logger.log(
        `Deduped into #${duplicate.id} in "${write.namespace}" (similarity ${duplicate.score?.toFixed(3)})`,
      );
      return duplicate;
    }

    const { rows } = await this.pool.query<MemoryRow>(
      `INSERT INTO ${this.schema}.memories
         (namespace, content, metadata, embedding, importance, source_session)
       VALUES ($1, $2, $3::jsonb, $4::vector, $5, $6)
       RETURNING id, namespace, content, metadata, importance, created_at, source_session`,
      [
        write.namespace,
        write.content,
        JSON.stringify(write.metadata ?? {}),
        toVectorLiteral(embedding),
        write.importance ?? 0.5,
        write.sourceSessionId ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert returned no row.');
    return toRecord(row);
  }

  async search(
    namespaces: string | string[],
    query: string,
    options: SearchOptions = {},
  ): Promise<MemoryRecord[]> {
    const scopes = toArray(namespaces);
    const topK = options.topK ?? 5;
    const minScore = options.minScore ?? 0;
    const pool = Math.max(topK * CANDIDATE_MULTIPLIER, MIN_CANDIDATES);

    const embedding = await this.embedder.embed(query, 'query');
    const { rows } = await this.pool.query<MemoryRow>(this.hybridSql, [
      scopes,
      toVectorLiteral(embedding),
      query,
      pool,
    ]);

    const scored = rows.map((row) => ({
      record: toRecord({ ...row, lexical: row.lex_rank !== null } as MemoryRow & { lexical: boolean }),
      rrf: rrfScore(branchRanks(row)),
    }));

    let hits = scored
      // A lexical match survives the cosine floor: it is exactly the exact-token
      // hit (a name, an id) that embeddings are known to rank poorly.
      .filter((s) => (s.record.score ?? 0) >= minScore || s.record.lexical === true)
      .sort((a, b) => finalWeight(b, options.halfLifeDays) - finalWeight(a, options.halfLifeDays))
      .map((s) => s.record);

    if (options.maxOverlap !== undefined) {
      hits = dropNearDuplicates(hits, options.maxOverlap, (h) => h.content);
    }
    return hits.slice(0, topK);
  }

  async neighbours(namespaces: string | string[], content: string, limit = 3): Promise<MemoryRecord[]> {
    const embedding = await this.embedder.embed(content, 'document');
    return this.nearest(toArray(namespaces), toVectorLiteral(embedding), limit);
  }

  async supersede(namespaces: string | string[], ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE ${this.schema}.memories SET superseded_at = now()
        WHERE id = ANY($2::bigint[])
          AND namespace = ANY($1::text[])
          AND superseded_at IS NULL`,
      [toArray(namespaces), ids],
    );
    return rowCount ?? 0;
  }

  async list(namespace: string, limit = 50): Promise<MemoryRecord[]> {
    const { rows } = await this.pool.query<MemoryRow>(
      `SELECT id, namespace, content, metadata, importance, created_at, source_session
         FROM ${this.schema}.memories
        WHERE namespace = ANY($1::text[]) AND superseded_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [[namespace], limit],
    );
    return rows.map(toRecord);
  }

  /** Plain vector nearest-neighbour lookup, no fusion or filtering. */
  private async nearest(namespaces: string[], vector: string, limit: number): Promise<MemoryRecord[]> {
    const { rows } = await this.pool.query<MemoryRow>(
      `SELECT id, namespace, content, metadata, importance, created_at, source_session,
              1 - (embedding <=> $2::vector) AS score
         FROM ${this.schema}.memories
        WHERE namespace = ANY($1::text[]) AND superseded_at IS NULL
        ORDER BY embedding <=> $2::vector
        LIMIT $3`,
      [namespaces, vector, limit],
    );
    return rows.map(toRecord);
  }
}

/**
 * Final ordering. RRF decides which candidates are relevant at all; recency and
 * importance then decide the order among them — importance shifts ranking without
 * being able to override relevance.
 */
function finalWeight(scored: { record: MemoryRecord; rrf: number }, halfLifeDays?: number): number {
  const recency = halfLifeDays ? recencyWeight(scored.record.createdAt, halfLifeDays) : 1;
  return scored.rrf * recency * (0.5 + 0.5 * scored.record.importance);
}

function recencyWeight(createdAt: Date, halfLifeDays: number): number {
  const ageDays = (Date.now() - createdAt.getTime()) / 86_400_000;
  const decayed = Math.pow(0.5, Math.max(ageDays, 0) / halfLifeDays);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decayed;
}

function branchRanks(row: MemoryRow): BranchRanks {
  return {
    vector: row.vec_rank ?? null,
    lexical: row.lex_rank ?? null,
  };
}

function toArray(namespaces: string | string[]): string[] {
  return Array.isArray(namespaces) ? namespaces : [namespaces];
}

function toRecord(row: MemoryRow & { lexical?: boolean }): MemoryRecord {
  return {
    id: Number(row.id),
    namespace: row.namespace,
    content: row.content,
    metadata: row.metadata,
    importance: Number(row.importance),
    sourceSessionId: row.source_session,
    createdAt: row.created_at,
    ...(row.score !== undefined && { score: Number(row.score) }),
    ...(row.lexical !== undefined && { lexical: row.lexical }),
  };
}
