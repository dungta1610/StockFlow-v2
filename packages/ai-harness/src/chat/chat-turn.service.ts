import { Inject, Injectable, Logger } from '@nestjs/common';
import { AGENT_RUNTIME, HARNESS_CONFIG, type ResolvedHarnessConfig } from '../config/harness-config';
import type { AgentDefinition, RunContext, RunEvent, RunInput, RunResult, StrategyDefinition } from '../config/types';
import { ConsolidationService } from '../memory/consolidation.service';
import { RetrievalService } from '../memory/retrieval.service';
import type { AgentRuntime } from '../runtime/agent-runtime.interface';
import { SessionService } from '../session/session.service';
import { SessionSummaryService } from '../session/session-summary.service';
import { ToolRegistry } from '../tools/tool.registry';

/**
 * One turn, as a caller asks for it. Narrower than `RunInput` because the three
 * fields it leaves out — history, tools, the prompt extras — are precisely what
 * this service exists to work out.
 */
export type ChatTurnInput = Omit<RunInput, 'tools' | 'history' | 'systemPromptExtra'>;

/**
 * Runs a complete chat turn: replay → recall → agent → persist → consolidate.
 *
 * In the harness this was ported from, this sequence lived in an HTTP controller.
 * A package cannot ship a controller — routes need the application's guards — so
 * porting it as-is would have left the orchestration behind and, with it, the
 * rule that makes memory form at all. It lives here instead, and the HTTP layer
 * becomes what it should be: authorise, call, stream out.
 */
@Injectable()
export class ChatTurnService {
  private readonly logger = new Logger('ChatTurn');
  /** Background passes already started; see `settled`. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(AGENT_RUNTIME) private readonly runtime: AgentRuntime,
    @Inject(HARNESS_CONFIG) private readonly config: ResolvedHarnessConfig,
    private readonly sessions: SessionService,
    private readonly summaries: SessionSummaryService,
    private readonly retrieval: RetrievalService,
    private readonly consolidation: ConsolidationService,
    private readonly tools: ToolRegistry,
  ) {}

  async *stream(input: ChatTurnInput): AsyncIterable<RunEvent> {
    const prepared = await this.prepare(input);
    let reply = '';

    for await (const event of this.runtime.stream(prepared)) {
      if (event.type === 'text') reply += event.delta;
      yield event;
    }

    await this.finish(input, reply);
  }

  async run(input: ChatTurnInput): Promise<RunResult> {
    const result = await this.runtime.run(await this.prepare(input));
    await this.finish(input, result.text);
    return result;
  }

  /**
   * Steps 1–3: store the user's message, replay the recent window, recall memory,
   * and build this request's tools.
   */
  private async prepare(input: ChatTurnInput): Promise<RunInput> {
    const ctx = input.context;
    const scope = { tenantId: ctx.principal.tenantId };
    const agent = this.agent(input.agentName);

    await this.sessions.addMessage(ctx.sessionId, scope, 'user', input.input);

    // Only the recent window is replayed verbatim; older turns arrive as a summary.
    const window = await this.sessions.getMessages(ctx.sessionId, {
      ...scope,
      limit: this.config.chat.replayWindow,
    });
    const history = window.map((m) => ({ role: m.role, content: m.content }));
    const stored = await this.summaries.get(ctx.sessionId, scope);

    const sections: string[] = [];
    if (stored) sections.push(`Earlier in this conversation:\n${stored.summary}`);

    const plan = this.memoryPlan(agent, ctx);
    if (plan) {
      const recalled = this.retrieval.format(
        await this.retrieval.recall({
          scope: plan.scope,
          strategies: plan.strategies,
          latest: input.input,
          history,
        }),
      );
      if (recalled.length > 0) sections.push(`What you remember about this user:\n${recalled}`);
    }

    return {
      agentName: input.agentName,
      input: input.input,
      context: ctx,
      // The turn being taken is the last entry of the window; it is the prompt,
      // not history, and replaying it would show the model its own question twice.
      history: history.slice(0, -1),
      tools: this.tools.build(agent.toolNames, ctx),
      ...(sections.length > 0 && { systemPromptExtra: sections.join('\n\n') }),
    };
  }

  /** Steps 4–5: persist the reply, then let maintenance run behind it. */
  private async finish(input: ChatTurnInput, reply: string): Promise<void> {
    const scope = { tenantId: input.context.principal.tenantId };
    if (reply.length > 0) {
      await this.sessions.addMessage(input.context.sessionId, scope, 'assistant', reply);
    }
    this.scheduleMaintenance(input);
  }

  /**
   * Compress the conversation and fold it into long-term memory, in the
   * background.
   *
   * Deliberately not awaited: the reply has already been delivered, and these
   * passes cost seconds. A crash mid-pass loses that pass — acceptable, because
   * the next one re-reads the same transcript.
   */
  private scheduleMaintenance(input: ChatTurnInput): void {
    const pass = this.maintain(input)
      .catch((err: unknown) => {
        this.logger.warn(`Background maintenance failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => this.inFlight.delete(pass));
    this.inFlight.add(pass);
  }

  /**
   * Resolves once every background pass started so far has finished.
   *
   * Two callers need this. A test, which cannot assert on memory that may still
   * be forming — and awaiting a fixed delay instead would be flaky by
   * construction. And a process shutting down, which would otherwise kill a pass
   * halfway through its writes.
   */
  async settled(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  /** Exposed for callers that want the pass to finish before they return (tests, an explicit endpoint). */
  async maintain(input: ChatTurnInput): Promise<void> {
    const ctx = input.context;
    const scope = { tenantId: ctx.principal.tenantId };

    const claimed = await this.sessions.claimConsolidation(
      ctx.sessionId,
      scope,
      this.config.chat.consolidateAfterMessages,
    );
    if (!claimed) return;

    // Summarising is a session concern, not a memory one: an agent without
    // long-term memory still needs its older turns compressed, or its per-turn
    // cost keeps growing with the conversation.
    await this.summaries.refresh(ctx.sessionId, scope, this.config.chat.replayWindow);

    const plan = this.memoryPlan(this.agent(input.agentName), ctx);
    if (!plan) return;

    // The whole transcript, not the window: this is what makes a failed pass
    // late rather than lost, since the next pass covers the same ground again.
    const transcript = await this.sessions.getMessages(ctx.sessionId, scope);
    await this.consolidation.consolidate({
      scope: plan.scope,
      strategies: plan.strategies,
      transcript: transcript.map((m) => ({ role: m.role, content: m.content })),
      sessionId: ctx.sessionId,
    });
  }

  private agent(name: string): AgentDefinition {
    const agent = this.config.agents.find((a) => a.name === name);
    if (!agent) {
      throw new Error(`Unknown agent "${name}". Registered: ${this.config.agents.map((a) => a.name).join(', ')}`);
    }
    return agent;
  }

  /** Where this agent's memories live for this caller, and which passes act on them. */
  private memoryPlan(
    agent: AgentDefinition,
    ctx: RunContext,
  ): { scope: string; strategies: StrategyDefinition[] } | null {
    if (!agent.memory) return null;
    const wanted = agent.memory.strategies;
    const strategies = wanted
      ? this.config.strategies.filter((s) => wanted.includes(s.name))
      : this.config.strategies;
    return strategies.length > 0 ? { scope: agent.memory.scope(ctx), strategies } : null;
  }
}
