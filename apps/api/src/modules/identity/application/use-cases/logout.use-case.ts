import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../../platform/database/tx';
import { RefreshTokenRepository } from '../ports/refresh-token.repository';
import { hashRefreshToken } from '../session-issuer';

/** Ends the session family the presented refresh token belongs to. Idempotent. */
@Injectable()
export class LogoutUseCase {
  constructor(private readonly tokens: RefreshTokenRepository) {}

  async execute(db: Tx, rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const known = await this.tokens.findByHash(db, hashRefreshToken(rawToken));
    if (known) await this.tokens.revokeFamily(db, known.familyId);
  }
}
