import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { HARNESS_CONFIG, LLM_GATEWAY, type ResolvedHarnessConfig } from '../config/harness-config';
import type { LlmGateway } from '../llm/llm-gateway.interface';

export interface SessionSummary {
  summary: string;
  /** Newest chat_messages.id already folded in. */
  coveredThrough: number;
}

/** Older turns folded into one summary per pass, to bound extraction cost. */
const FOLD_BUDGET = 6_000;

/**
 * Keeps a running summary of the older part of a conversation.
 *
 * Without it, every turn replays the entire transcript: cost grows linearly with
 * conversation length and eventually overruns the context window with nothing
 * guarding it. With it, the agent sees a summary of what came before plus the
 * most recent turns verbatim.
 */
@Injectable()
export class SessionSummaryService {
  private readonly logger = new Logger('SessionSummary');
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(
    @Inject(HARNESS_CONFIG) config: ResolvedHarnessConfig,
    @Inject(LLM_GATEWAY) private readonly llm: LlmGateway,
  ) {
    this.pool = config.db.pool;
    this.schema = config.db.schema;
  }

  async get(sessionId: string, scope: { tenantId: string }): Promise<SessionSummary | null> {
    const { rows } = await this.pool.query<{ summary: string; covered_through: string }>(
      `SELECT ss.summary, ss.covered_through
         FROM ${this.schema}.session_summaries ss
         JOIN ${this.schema}.chat_sessions s ON s.id = ss.session_id
        WHERE ss.session_id = $1 AND s.tenant_id = $2`,
      [sessionId, scope.tenantId],
    );
    const row = rows[0];
    return row ? { summary: row.summary, coveredThrough: Number(row.covered_through) } : null;
  }

  /**
   * Fold every turn that has fallen outside the replay window into the summary.
   *
   * `keepRecent` must match the window the agent is given verbatim, so each turn
   * is represented exactly once — either in the window or in the summary, never
   * both and never neither.
   */
  async refresh(sessionId: string, scope: { tenantId: string }, keepRecent: number): Promise<void> {
    const boundary = await this.windowBoundary(sessionId, scope.tenantId, keepRecent);
    // Nothing has aged out of the window yet.
    if (boundary === null) return;

    const current = await this.get(sessionId, scope);
    const coveredThrough = current?.coveredThrough ?? 0;

    const { rows } = await this.pool.query<{ role: string; content: string }>(
      `SELECT m.role, m.content
         FROM ${this.schema}.chat_messages m
         JOIN ${this.schema}.chat_sessions s ON s.id = m.session_id
        WHERE m.session_id = $1 AND s.tenant_id = $2 AND m.id > $3 AND m.id <= $4
        ORDER BY m.id ASC`,
      [sessionId, scope.tenantId, coveredThrough, boundary],
    );
    if (rows.length === 0) return;

    let block = rows.map((r) => `${r.role}: ${r.content}`).join('\n');
    if (block.length > FOLD_BUDGET) block = block.slice(-FOLD_BUDGET);

    const prompt = [
      current?.summary
        ? 'Update the running summary of a conversation with the new turns below.'
        : 'Summarise the conversation turns below.',
      'Keep the decisions, facts and open threads that later turns would need.',
      'Drop pleasantries. Write prose, no preamble, no more than 200 words.',
      '',
      ...(current?.summary ? ['Current summary:', current.summary, ''] : []),
      'New turns:',
      block,
    ].join('\n');

    try {
      const summary = (await this.llm.complete(prompt, { maxTokens: 400 })).trim();
      if (summary.length === 0) return;

      await this.pool.query(
        `INSERT INTO ${this.schema}.session_summaries (session_id, summary, covered_through)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id) DO UPDATE
           SET summary = EXCLUDED.summary,
               covered_through = EXCLUDED.covered_through,
               updated_at = now()`,
        [sessionId, summary, boundary],
      );
      this.logger.log(`Session ${sessionId.slice(0, 8)}: folded ${rows.length} turns through id ${boundary}`);
    } catch (err) {
      // A missing summary degrades quality, it does not break the conversation.
      this.logger.warn(`Summary refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Id of the newest message that sits *outside* the replay window, or null when
   * the conversation is still short enough to replay whole.
   */
  private async windowBoundary(
    sessionId: string,
    tenantId: string,
    keepRecent: number,
  ): Promise<number | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT m.id
         FROM ${this.schema}.chat_messages m
         JOIN ${this.schema}.chat_sessions s ON s.id = m.session_id
        WHERE m.session_id = $1 AND s.tenant_id = $2
        ORDER BY m.id DESC
        OFFSET $3 LIMIT 1`,
      [sessionId, tenantId, keepRecent],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }
}
