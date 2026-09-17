import type { Tx } from '../../../../platform/database/tx';

export interface StoredRefreshToken {
  userId: string;
  orgId: string;
  familyId: string;
  sessionExpiresAt: Date;
}

export abstract class RefreshTokenRepository {
  abstract create(
    tx: Tx,
    data: StoredRefreshToken & { tokenHash: string; expiresAt: Date },
  ): Promise<void>;

  /**
   * Marks the token used in one statement and returns it — only if it was unused,
   * unrevoked and unexpired. Two concurrent refreshes with the same token cannot
   * both succeed.
   */
  abstract claim(tx: Tx, tokenHash: string): Promise<StoredRefreshToken | null>;

  /** Looks up a token regardless of state, to tell "spent" apart from "never existed". */
  abstract findByHash(
    tx: Tx,
    tokenHash: string,
  ): Promise<{ familyId: string; spent: boolean } | null>;

  abstract revokeFamily(tx: Tx, familyId: string): Promise<void>;

  /** Ends every session of a user (password change, deactivation). */
  abstract revokeAllForUser(tx: Tx, userId: string): Promise<void>;
}
