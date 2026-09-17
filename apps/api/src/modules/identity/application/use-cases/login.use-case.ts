import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../../platform/config/env.schema';
import type { Tx } from '../../../../platform/database/tx';
import { RateLimiter } from '../../../../platform/ratelimit/limiter';
import { IdentityErrors } from '../../domain/errors';
import { PasswordHasher } from '../ports/password-hasher';
import { UserRepository } from '../ports/user.repository';
import { type Session, SessionIssuer } from '../session-issuer';

export interface LoginInput {
  email: string;
  password: string;
  orgCode?: string;
}

/**
 * Email/password login.
 *
 * Unknown email, wrong password and inactive account are indistinguishable: same
 * error, and the password hash is checked even when the email does not exist so
 * response time does not reveal it either. Failures are counted per account and per
 * client IP in Redis — also for emails that do not exist, so the lockout itself
 * cannot be used to discover which accounts are real.
 */
@Injectable()
export class LoginUseCase {
  private readonly maxPerAccount: number;
  private readonly maxPerIp: number;
  private readonly windowSeconds: number;
  private dummyHash?: Promise<string>;

  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiter,
    private readonly sessions: SessionIssuer,
    config: ConfigService<Env, true>,
  ) {
    this.maxPerAccount = config.get('LOGIN_MAX_ATTEMPTS', { infer: true });
    this.maxPerIp = config.get('LOGIN_MAX_ATTEMPTS_PER_IP', { infer: true });
    this.windowSeconds = config.get('LOGIN_WINDOW_SECONDS', { infer: true });
  }

  async execute(db: Tx, input: LoginInput, clientIp: string): Promise<Session> {
    const accountKey = `login:account:${input.email}`;
    const ipKey = `login:ip:${clientIp}`;

    // Count the attempt *before* checking the password. Checking first and counting
    // after would let a burst of parallel requests all pass the check. A successful
    // login gives its hits back, so in effect only failures count.
    const [accountOk, ipOk] = await Promise.all([
      this.limiter.hit(accountKey, this.maxPerAccount, this.windowSeconds),
      this.limiter.hit(ipKey, this.maxPerIp, this.windowSeconds),
    ]);
    if (!accountOk || !ipOk) throw IdentityErrors.loginLocked();

    const found = await this.users.findCredentialsByEmail(db, input.email);
    const passwordOk = await this.hasher.verify(
      found?.passwordHash ?? (await this.getDummyHash()),
      input.password,
    );

    if (!found || !passwordOk || !found.user.isActive) {
      throw IdentityErrors.invalidCredentials();
    }

    // Past this point the password is proven, so listing the account's organisations is safe.
    const active = found.user.memberships.filter((m) => m.orgIsActive);
    const actingAs = input.orgCode ? active.find((m) => m.orgCode === input.orgCode) : active[0];
    if (!input.orgCode && active.length > 1) {
      throw IdentityErrors.orgSelectionRequired(active.map((m) => m.orgCode));
    }
    if (!actingAs) throw IdentityErrors.invalidCredentials();

    await Promise.all([this.limiter.reset(accountKey), this.limiter.release(ipKey)]);
    return this.sessions.issue(db, found.user, actingAs);
  }

  /** A real argon2id hash of a random value, computed once, used to equalise timing. */
  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hasher.hash(`dummy-${Math.random()}-${Date.now()}`);
    return this.dummyHash;
  }
}
