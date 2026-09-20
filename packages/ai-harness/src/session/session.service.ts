import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { HARNESS_CONFIG, type ResolvedHarnessConfig } from '../config/harness-config';

export interface ChatSession {
  id: string;
  agentName: string;
  tenantId: string;
  ownerUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A session plus how many turns it holds — enough to render a session list. */
export interface ChatSessionSummary extends ChatSession {
  messageCount: number;
}

export interface StoredMessage {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

/**
 * Who a session belongs to. Required on every read, never optional and never
 * defaulted: a role says what a caller may do, not whose data they may see, and a
 * session id is guessable enough that "knows the id" cannot be the check.
 */
export interface SessionOwner {
  tenantId: string;
  ownerUserId: string;
}

interface SessionRow {
  id: string;
  agent_name: string;
  tenant_id: string;
  owner_user_id: string;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: Date;
}

/**
 * Chat sessions and their messages.
 *
 * Every statement that reads a session filters on `tenant_id`. The methods that
 * work inside an already-authorised turn (`addMessage`, `getMessages`,
 * `claimConsolidation`) take the tenant too and join through the session, so
 * there is no path into a transcript that skipped the check.
 */
@Injectable()
export class SessionService {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(@Inject(HARNESS_CONFIG) config: ResolvedHarnessConfig) {
    this.pool = config.db.pool;
    this.schema = config.db.schema;
  }

  async create(agentName: string, owner: SessionOwner): Promise<ChatSession> {
    const { rows } = await this.pool.query<SessionRow>(
      `INSERT INTO ${this.schema}.chat_sessions (agent_name, tenant_id, owner_user_id)
       VALUES ($1, $2, $3)
       RETURNING id, agent_name, tenant_id, owner_user_id, created_at, updated_at`,
      [agentName, owner.tenantId, owner.ownerUserId],
    );
    return toSession(rows[0]!);
  }

  /**
   * Sessions in one tenant, most recent activity first.
   *
   * `ownerUserId` narrows further to one person's own conversations. The caller
   * decides which it wants — the harness has no notion of a role that may read
   * everyone's.
   */
  async list(
    scope: { tenantId: string; ownerUserId?: string },
    limit = 50,
  ): Promise<ChatSessionSummary[]> {
    const { rows } = await this.pool.query<SessionRow & { message_count: number }>(
      `SELECT s.id, s.agent_name, s.tenant_id, s.owner_user_id, s.created_at, s.updated_at,
              count(m.id)::int AS message_count
         FROM ${this.schema}.chat_sessions s
         LEFT JOIN ${this.schema}.chat_messages m ON m.session_id = s.id
        WHERE s.tenant_id = $1
          AND ($2::uuid IS NULL OR s.owner_user_id = $2)
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT $3`,
      [scope.tenantId, scope.ownerUserId ?? null, limit],
    );
    return rows.map((row) => ({ ...toSession(row), messageCount: row.message_count }));
  }

  /** A session inside one tenant, or null — an id from another tenant simply does not exist. */
  async get(sessionId: string, scope: { tenantId: string }): Promise<ChatSession | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT id, agent_name, tenant_id, owner_user_id, created_at, updated_at
         FROM ${this.schema}.chat_sessions
        WHERE id = $1 AND tenant_id = $2`,
      [sessionId, scope.tenantId],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  /** Append a message and touch the session's activity time. */
  async addMessage(
    sessionId: string,
    scope: { tenantId: string },
    role: 'user' | 'assistant',
    content: string,
  ): Promise<StoredMessage> {
    const { rows } = await this.pool.query<MessageRow>(
      `INSERT INTO ${this.schema}.chat_messages (session_id, role, content)
       SELECT s.id, $3, $4
         FROM ${this.schema}.chat_sessions s
        WHERE s.id = $1 AND s.tenant_id = $2
       RETURNING id, session_id, role, content, created_at`,
      [sessionId, scope.tenantId, role, content],
    );
    const row = rows[0];
    if (!row) throw new Error(`Session "${sessionId}" not found in this tenant.`);

    await this.pool.query(
      `UPDATE ${this.schema}.chat_sessions SET updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [sessionId, scope.tenantId],
    );
    return toMessage(row);
  }

  /**
   * Messages in a session, oldest first.
   *
   * `limit` returns only the most recent turns — the replay window handed to the
   * agent. Anything older is represented by the running summary instead, which is
   * what keeps per-turn cost from growing with conversation length. Omit it to
   * read the whole transcript, as a consolidation pass does.
   */
  async getMessages(
    sessionId: string,
    scope: { tenantId: string; limit?: number },
  ): Promise<StoredMessage[]> {
    const { rows } = await this.pool.query<MessageRow>(
      scope.limit === undefined
        ? `SELECT m.id, m.session_id, m.role, m.content, m.created_at
             FROM ${this.schema}.chat_messages m
             JOIN ${this.schema}.chat_sessions s ON s.id = m.session_id
            WHERE m.session_id = $1 AND s.tenant_id = $2
            ORDER BY m.created_at ASC, m.id ASC`
        : // Take the newest rows, then put them back in reading order.
          `SELECT * FROM (
             SELECT m.id, m.session_id, m.role, m.content, m.created_at
               FROM ${this.schema}.chat_messages m
               JOIN ${this.schema}.chat_sessions s ON s.id = m.session_id
              WHERE m.session_id = $1 AND s.tenant_id = $2
              ORDER BY m.created_at DESC, m.id DESC
              LIMIT $3
           ) recent
           ORDER BY created_at ASC, id ASC`,
      scope.limit === undefined ? [sessionId, scope.tenantId] : [sessionId, scope.tenantId, scope.limit],
    );
    return rows.map(toMessage);
  }

  /**
   * Reserve a consolidation pass when at least `minNewMessages` have arrived
   * since the last one, moving the marker in the same statement.
   *
   * Gating on how many messages are *new* is what makes this reliable. Gating on
   * the total being divisible by N misses conversations outright: one complete
   * turn is two messages, so a single-turn chat never qualifies, and an aborted
   * reply leaves the count odd forever, past every multiple of N.
   *
   * The marker advances before the pass runs rather than after, so a pass that
   * fails or hangs is not retried on every following turn. Nothing is lost:
   * the next pass re-reads the whole transcript, so the content is late, not gone.
   */
  async claimConsolidation(
    sessionId: string,
    scope: { tenantId: string },
    minNewMessages: number,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE ${this.schema}.chat_sessions s
          SET consolidated_through = pending.newest
         FROM (
           SELECT max(id) AS newest, count(*) AS n
             FROM ${this.schema}.chat_messages
            WHERE session_id = $1
              AND id > (SELECT consolidated_through
                          FROM ${this.schema}.chat_sessions WHERE id = $1)
         ) pending
        WHERE s.id = $1 AND s.tenant_id = $2 AND pending.n >= $3`,
      [sessionId, scope.tenantId, minNewMessages],
    );
    return (rowCount ?? 0) > 0;
  }
}

function toSession(row: SessionRow): ChatSession {
  return {
    id: row.id,
    agentName: row.agent_name,
    tenantId: row.tenant_id,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}
