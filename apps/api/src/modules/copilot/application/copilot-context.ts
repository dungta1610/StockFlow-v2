import { Injectable } from '@nestjs/common';
import type { RunContext } from '@stockflow/ai-harness';
import type { Tx } from '../../../platform/database/tx';
import { UserRepository } from '../../identity/application/ports/user.repository';
import { type Actor, assertRole } from '../../identity/domain/actor';
import { IdentityErrors } from '../../identity/domain/errors';
import { type OrgScope, orgScopeOf } from '../../identity/domain/org-scope';

/**
 * Translates an authenticated caller into the context the harness carries, and back.
 *
 * `RunContext.principal` is deliberately thin — `{id, tenantId}` — because the
 * harness must not know what a role or an organisation type is. Everything a tool
 * needs in order to be safe is therefore rebuilt here, from the database, rather
 * than carried along inside the conversation: roles change, and a turn taken an
 * hour after login should act on the roles the person has now.
 */
export const toRunContext = (actor: Actor, sessionId: string): RunContext => ({
  sessionId,
  principal: { id: actor.userId, tenantId: actor.orgId },
});

export interface ResolvedCaller {
  actor: Actor;
  scope: OrgScope;
}

@Injectable()
export class CopilotActorResolver {
  constructor(private readonly users: UserRepository) {}

  /**
   * The caller behind a run context, with the copilot's own precondition applied:
   * this agent is for operations staff. That check lives here rather than only on
   * the route because a tool is reachable from anywhere the harness runs, and a
   * guard that only exists at the edge is a guard with a way around it.
   */
  async resolve(db: Tx, ctx: RunContext): Promise<ResolvedCaller> {
    const found = await this.users.findActiveMembership(db, ctx.principal.id, ctx.principal.tenantId);
    if (!found) throw IdentityErrors.invalidToken();

    const actor: Actor = {
      userId: found.user.id,
      orgId: found.membership.orgId,
      orgType: found.membership.orgType,
      roles: [found.membership.role],
    };
    assertRole(actor, 'ops', 'ops_admin');
    return { actor, scope: orgScopeOf(actor) };
  }
}
