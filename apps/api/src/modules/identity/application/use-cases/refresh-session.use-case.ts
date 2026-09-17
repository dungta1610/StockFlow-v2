import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../../platform/database/tx';
import { IdentityErrors } from '../../domain/errors';
import { RefreshTokenRepository } from '../ports/refresh-token.repository';
import { UserRepository } from '../ports/user.repository';
import { type Session, SessionIssuer, hashRefreshToken } from '../session-issuer';

/**
 * Rotates a refresh token.
 *
 * Runs on an autocommit handle on purpose: when a spent token is presented, the
 * family revocation must stick even though the request then fails — inside a
 * transaction, throwing would roll the revocation back.
 */
@Injectable()
export class RefreshSessionUseCase {
  constructor(
    private readonly tokens: RefreshTokenRepository,
    private readonly users: UserRepository,
    private readonly sessions: SessionIssuer,
  ) {}

  async execute(db: Tx, rawToken: string | undefined): Promise<Session> {
    if (!rawToken) throw IdentityErrors.refreshInvalid();
    const tokenHash = hashRefreshToken(rawToken);

    const claimed = await this.tokens.claim(db, tokenHash);
    if (!claimed) {
      // A token that exists but was already used or revoked is being replayed:
      // assume it was stolen and end every session descended from that login.
      const known = await this.tokens.findByHash(db, tokenHash);
      if (known?.spent) await this.tokens.revokeFamily(db, known.familyId);
      throw IdentityErrors.refreshInvalid();
    }

    const current = await this.users.findActiveMembership(db, claimed.userId, claimed.orgId);
    if (!current) {
      await this.tokens.revokeFamily(db, claimed.familyId);
      throw IdentityErrors.refreshInvalid();
    }

    return this.sessions.issue(db, current.user, current.membership, {
      id: claimed.familyId,
      expiresAt: claimed.sessionExpiresAt,
    });
  }
}
