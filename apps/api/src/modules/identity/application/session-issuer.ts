import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Env } from '../../../platform/config/env.schema';
import type { Tx } from '../../../platform/database/tx';
import type { Membership, User } from '../domain/user';
import { AccessTokenService } from './ports/access-token.service';
import { RefreshTokenRepository } from './ports/refresh-token.repository';

export interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: User;
  actingAs: Membership;
}

/** Refresh tokens are 256-bit random values; only their SHA-256 is stored. */
export const hashRefreshToken = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex');

/** Identifies the login session a rotated token continues. */
export interface SessionFamily {
  id: string;
  expiresAt: Date;
}

/**
 * Issues an access token and a refresh token — in a new session family on login, or
 * in an existing one on rotation. A refresh token never outlives its session.
 */
@Injectable()
export class SessionIssuer {
  private readonly refreshTtlSeconds: number;
  private readonly sessionMaxSeconds: number;

  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokens: RefreshTokenRepository,
    config: ConfigService<Env, true>,
  ) {
    this.refreshTtlSeconds = config.get('JWT_REFRESH_TTL_SECONDS', { infer: true });
    this.sessionMaxSeconds = config.get('JWT_SESSION_MAX_SECONDS', { infer: true });
  }

  async issue(tx: Tx, user: User, actingAs: Membership, family?: SessionFamily): Promise<Session> {
    const now = Date.now();
    const session: SessionFamily = family ?? {
      id: randomUUID(),
      expiresAt: new Date(now + this.sessionMaxSeconds * 1000),
    };

    const { token, expiresIn } = await this.accessTokens.sign({
      userId: user.id,
      orgId: actingAs.orgId,
      orgType: actingAs.orgType,
      roles: [actingAs.role],
    });

    const refreshToken = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(
      Math.min(now + this.refreshTtlSeconds * 1000, session.expiresAt.getTime()),
    );
    await this.refreshTokens.create(tx, {
      userId: user.id,
      orgId: actingAs.orgId,
      familyId: session.id,
      sessionExpiresAt: session.expiresAt,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: refreshExpiresAt,
    });

    return { accessToken: token, expiresIn, refreshToken, refreshExpiresAt, user, actingAs };
  }
}
