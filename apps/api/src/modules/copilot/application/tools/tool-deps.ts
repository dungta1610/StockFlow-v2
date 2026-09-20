import { Injectable } from '@nestjs/common';
import type { RunContext } from '@stockflow/ai-harness';
import { UnitOfWork } from '../../../../platform/database/unit-of-work';
import type { Tx } from '../../../../platform/database/tx';
import { CopilotActorResolver, type ResolvedCaller } from '../copilot-context';

/**
 * What every copilot tool needs before it can do anything: a read handle, and the
 * caller it is running as.
 *
 * Authorisation is resolved inside the handler rather than when the tool is built,
 * for two reasons. A registry has to be able to read a tool's name without
 * fabricating a caller. And a role revoked mid-conversation takes effect on the
 * very next tool call instead of at the next login.
 */
@Injectable()
export class ToolDeps {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly actors: CopilotActorResolver,
  ) {}

  /**
   * Runs `work` as the caller behind `ctx`, on an autocommit handle. Reads only —
   * a tool that writes opens its own transaction.
   */
  async read<T>(ctx: RunContext, work: (db: Tx, caller: ResolvedCaller) => Promise<T>): Promise<T> {
    const db = this.uow.db;
    return work(db, await this.actors.resolve(db, ctx));
  }

  /** Runs `work` as the caller behind `ctx`, inside one transaction. */
  async write<T>(ctx: RunContext, work: (tx: Tx, caller: ResolvedCaller) => Promise<T>): Promise<T> {
    return this.uow.withTransaction(async (tx) => work(tx, await this.actors.resolve(tx, ctx)));
  }
}
