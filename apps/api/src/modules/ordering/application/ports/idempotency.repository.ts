import type { Tx } from '../../../../platform/database/tx';

export interface IdempotencyClaim {
  orgId: string;
  endpoint: string;
  key: string;
  requestHash: string;
}

export type ClaimOutcome =
  | { kind: 'claimed' }
  | {
      kind: 'taken';
      status: 'in_progress' | 'completed' | 'failed';
      requestHash: string;
      responseStatus: number | null;
      responseSnapshot: unknown;
    };

export abstract class IdempotencyRepository {
  /**
   * Takes the key in one statement that commits on its own: a new key, or one whose
   * last attempt failed. Otherwise reports who holds it.
   */
  abstract claim(db: Tx, claim: IdempotencyClaim): Promise<ClaimOutcome>;

  /** Locks the key to this response, in the transaction that did the work. */
  abstract complete(tx: Tx, claim: IdempotencyClaim, responseStatus: number, body: unknown): Promise<void>;

  /** Frees a key whose work failed, so the client may retry with it. */
  abstract release(db: Tx, claim: IdempotencyClaim): Promise<void>;

  /** Deletes keys created before `before`. Returns how many were removed — the TTL
   *  cleanup job that bounds this table's growth (docs/adr/0015). */
  abstract deleteExpired(tx: Tx, before: Date): Promise<number>;
}
