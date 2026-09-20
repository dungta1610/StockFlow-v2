import { Injectable } from '@nestjs/common';
import {
  ChatTurnService,
  SessionService,
  type ChatSession,
  type RunEvent,
  type StoredMessage,
} from '@stockflow/ai-harness';
import { type Actor, assertRole } from '../../../identity/domain/actor';
import { OPS_COPILOT_AGENT } from '../agent.registry';
import { toRunContext } from '../copilot-context';
import { CopilotErrors } from '../../domain/errors';

/**
 * The copilot's conversations.
 *
 * Every method starts the same two ways: assert the caller may use the copilot at
 * all, and resolve the session inside the caller's tenant. A transcript holds
 * whatever the tools looked up on the operator's behalf, so reading someone else's
 * is reading their data — which is why a session from another tenant is a 404 here
 * rather than a permission check somewhere upstream.
 */
@Injectable()
export class CopilotSessionUseCases {
  constructor(
    private readonly sessions: SessionService,
    private readonly turns: ChatTurnService,
  ) {}

  async create(actor: Actor): Promise<ChatSession> {
    assertRole(actor, 'ops', 'ops_admin');
    return this.sessions.create(OPS_COPILOT_AGENT.name, {
      tenantId: actor.orgId,
      ownerUserId: actor.userId,
    });
  }

  async list(actor: Actor): Promise<Awaited<ReturnType<SessionService['list']>>> {
    assertRole(actor, 'ops', 'ops_admin');
    // Every operator shares the internal organisation, and the team's conversations
    // are a shared record of how a question was answered — so the listing is the
    // tenant's, not one person's.
    return this.sessions.list({ tenantId: actor.orgId });
  }

  async get(actor: Actor, sessionId: string): Promise<{ session: ChatSession; messages: StoredMessage[] }> {
    const session = await this.require(actor, sessionId);
    const messages = await this.sessions.getMessages(sessionId, { tenantId: actor.orgId });
    return { session, messages };
  }

  /** One turn, streamed. Events go straight to the caller; persistence is the harness's. */
  async *stream(actor: Actor, sessionId: string, input: string): AsyncIterable<RunEvent> {
    const session = await this.require(actor, sessionId);
    yield* this.turns.stream({
      agentName: session.agentName,
      input,
      context: toRunContext(actor, sessionId),
    });
  }

  /** One turn, answered in full. */
  async send(actor: Actor, sessionId: string, input: string): Promise<string> {
    const session = await this.require(actor, sessionId);
    const result = await this.turns.run({
      agentName: session.agentName,
      input,
      context: toRunContext(actor, sessionId),
    });
    return result.text;
  }

  /** Lets a caller wait for the background memory pass — used by tests and shutdown. */
  settled(): Promise<void> {
    return this.turns.settled();
  }

  private async require(actor: Actor, sessionId: string): Promise<ChatSession> {
    assertRole(actor, 'ops', 'ops_admin');
    const session = await this.sessions.get(sessionId, { tenantId: actor.orgId });
    if (!session) throw CopilotErrors.sessionNotFound();
    return session;
  }
}
