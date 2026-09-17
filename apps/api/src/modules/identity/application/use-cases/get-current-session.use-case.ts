import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../../platform/database/tx';
import type { Actor } from '../../domain/actor';
import { IdentityErrors } from '../../domain/errors';
import type { Membership, User } from '../../domain/user';
import { UserRepository } from '../ports/user.repository';

/** The caller and the membership their token acts with (GET /auth/me). */
@Injectable()
export class GetCurrentSessionUseCase {
  constructor(private readonly users: UserRepository) {}

  async execute(db: Tx, actor: Actor): Promise<{ user: User; actingAs: Membership }> {
    const current = await this.users.findActiveMembership(db, actor.userId, actor.orgId);
    // The token is still valid but the account or membership is gone.
    if (!current) throw IdentityErrors.sessionInvalid();
    return { user: current.user, actingAs: current.membership };
  }
}
