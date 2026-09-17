import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../platform/database/tx';
import {
  RefreshTokenRepository,
  type StoredRefreshToken,
} from '../application/ports/refresh-token.repository';

interface TokenRow {
  user_id: string;
  org_id: string;
  family_id: string;
  session_expires_at: Date;
}

@Injectable()
export class SqlRefreshTokenRepository extends RefreshTokenRepository {
  async create(tx: Tx, data: StoredRefreshToken & { tokenHash: string; expiresAt: Date }): Promise<void> {
    await tx.query(
      `INSERT INTO refresh_tokens (user_id, org_id, family_id, token_hash, expires_at, session_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [data.userId, data.orgId, data.familyId, data.tokenHash, data.expiresAt, data.sessionExpiresAt],
    );
  }

  async claim(tx: Tx, tokenHash: string): Promise<StoredRefreshToken | null> {
    // A family, once revoked, stays dead: a token issued into it *after* the revocation
    // (a refresh that was mid-flight when reuse was detected) must not work either.
    const [row] = await tx.query<TokenRow>(
      `UPDATE refresh_tokens t
          SET used_at = now()
        WHERE t.token_hash = $1
          AND t.used_at IS NULL
          AND t.revoked_at IS NULL
          AND t.expires_at > now()
          AND NOT EXISTS (
            SELECT 1 FROM refresh_tokens r
             WHERE r.family_id = t.family_id AND r.revoked_at IS NOT NULL)
        RETURNING t.user_id, t.org_id, t.family_id, t.session_expires_at`,
      [tokenHash],
    );
    return row
      ? {
          userId: row.user_id,
          orgId: row.org_id,
          familyId: row.family_id,
          sessionExpiresAt: row.session_expires_at,
        }
      : null;
  }

  async findByHash(tx: Tx, tokenHash: string): Promise<{ familyId: string; spent: boolean } | null> {
    const [row] = await tx.query<{ family_id: string; spent: boolean }>(
      `SELECT family_id, (used_at IS NOT NULL OR revoked_at IS NOT NULL) AS spent
         FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    return row ? { familyId: row.family_id, spent: row.spent } : null;
  }

  async revokeFamily(tx: Tx, familyId: string): Promise<void> {
    await tx.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId],
    );
  }

  async revokeAllForUser(tx: Tx, userId: string): Promise<void> {
    await tx.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }
}
