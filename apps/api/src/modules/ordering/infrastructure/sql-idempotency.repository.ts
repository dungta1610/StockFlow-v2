import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../platform/database/tx';
import {
  type ClaimOutcome,
  type IdempotencyClaim,
  IdempotencyRepository,
} from '../application/ports/idempotency.repository';

interface KeyRow {
  status: 'in_progress' | 'completed' | 'failed';
  request_hash: string;
  response_status: number | null;
  response_snapshot: unknown;
}

@Injectable()
export class SqlIdempotencyRepository extends IdempotencyRepository {
  /**
   * One statement, so it commits on its own before any order work starts. A key whose
   * last attempt failed is taken over — with the new request's hash, because the
   * client is expected to retry with a corrected body. Two retries racing for a
   * failed key serialise on its row lock; the loser re-checks `status = 'failed'`
   * against the winner's committed row, matches nothing, and reads the claim.
   */
  async claim(db: Tx, c: IdempotencyClaim): Promise<ClaimOutcome> {
    const claimed = await db.query(
      `INSERT INTO idempotency_keys AS k (org_id, endpoint, key, request_hash, status)
       VALUES ($1, $2, $3, $4, 'in_progress')
       ON CONFLICT (org_id, endpoint, key) DO UPDATE
          SET request_hash = EXCLUDED.request_hash, status = 'in_progress',
              response_status = NULL, response_snapshot = NULL, updated_at = now()
        WHERE k.status = 'failed'
       RETURNING 1`,
      [c.orgId, c.endpoint, c.key, c.requestHash],
    );
    if (claimed.length > 0) return { kind: 'claimed' };

    const [row] = await db.query<KeyRow>(
      `SELECT status, request_hash, response_status, response_snapshot
         FROM idempotency_keys WHERE org_id = $1 AND endpoint = $2 AND key = $3`,
      [c.orgId, c.endpoint, c.key],
    );
    // Gone between the two statements (a cleanup job): report it as busy, the client retries.
    if (!row) return { kind: 'taken', status: 'in_progress', requestHash: c.requestHash, responseStatus: null, responseSnapshot: null };
    return {
      kind: 'taken',
      status: row.status,
      requestHash: row.request_hash,
      responseStatus: row.response_status,
      responseSnapshot: row.response_snapshot,
    };
  }

  async complete(tx: Tx, c: IdempotencyClaim, responseStatus: number, body: unknown): Promise<void> {
    const done = await tx.query(
      `UPDATE idempotency_keys
          SET status = 'completed', response_status = $5, response_snapshot = $6, updated_at = now()
        WHERE org_id = $1 AND endpoint = $2 AND key = $3 AND request_hash = $4 AND status = 'in_progress'
       RETURNING 1`,
      [c.orgId, c.endpoint, c.key, c.requestHash, responseStatus, JSON.stringify(body)],
    );
    // The claim vanished or changed hands mid-flight. Committing the work anyway would
    // leave it unprotected: a retry with this key would do it a second time.
    if (done.length === 0) throw new Error(`Idempotency key ${c.key} is no longer held by this request`);
  }

  async release(db: Tx, c: IdempotencyClaim): Promise<void> {
    await db.query(
      `UPDATE idempotency_keys SET status = 'failed', updated_at = now()
        WHERE org_id = $1 AND endpoint = $2 AND key = $3 AND request_hash = $4 AND status = 'in_progress'`,
      [c.orgId, c.endpoint, c.key, c.requestHash],
    );
  }
}
