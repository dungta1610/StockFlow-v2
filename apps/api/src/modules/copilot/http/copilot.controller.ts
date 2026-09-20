import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type CreateCopilotSessionRequest,
  type SendCopilotMessageRequest,
  createCopilotSessionRequestSchema,
  sendCopilotMessageRequestSchema,
} from '@stockflow/contracts';
import type { Request, Response } from 'express';
import type { Env } from '../../../platform/config/env.schema';
import { RateLimiter } from '../../../platform/ratelimit/limiter';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { DomainError } from '../../../platform/errors/domain-error';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor, Roles } from '../../identity/http/auth.decorators';
import { CopilotSessionUseCases } from '../application/use-cases/copilot-session.use-cases';
import { presentEvent, presentMessage, presentSession } from './presenters';

/**
 * The copilot's HTTP surface: authorise, call the use case, stream the result out.
 *
 * There is no orchestration here — that lives in the harness's `ChatTurnService`
 * (docs/adr/0020) — and no data access. `@Roles` is the outer of two layers: the
 * use cases assert the same roles themselves, because a tool can be reached
 * without an HTTP request.
 */
@Controller('copilot')
@Roles('ops', 'ops_admin')
export class CopilotController {
  constructor(
    private readonly sessions: CopilotSessionUseCases,
    private readonly limiter: RateLimiter,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post('sessions')
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createCopilotSessionRequestSchema)) _body: CreateCopilotSessionRequest,
  ) {
    return { data: presentSession(await this.sessions.create(actor)) };
  }

  @Get('sessions')
  async list(@CurrentActor() actor: Actor) {
    const sessions = await this.sessions.list(actor);
    return { data: sessions.map((s) => presentSession(s, s.messageCount)) };
  }

  @Get('sessions/:sessionId')
  async get(@CurrentActor() actor: Actor, @Param('sessionId', ParseUUIDPipe) sessionId: string) {
    const { session, messages } = await this.sessions.get(actor, sessionId);
    return { data: { session: presentSession(session), messages: messages.map(presentMessage) } };
  }

  /**
   * One turn. Streams when the caller asks for `text/event-stream`, otherwise
   * answers in full.
   */
  @Post('sessions/:sessionId/messages')
  // A turn creates no resource the caller can address, so 200 rather than Nest's
  // default 201 for POST. It also has to be the status of an SSE response.
  @HttpCode(200)
  async send(
    @CurrentActor() actor: Actor,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodValidationPipe(sendCopilotMessageRequestSchema)) body: SendCopilotMessageRequest,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.assertWithinBudget(actor);

    if (!(req.headers.accept ?? '').includes('text/event-stream')) {
      const reply = await this.sessions.send(actor, sessionId, body.input);
      res.json({ data: { reply } });
      return;
    }

    // Authorisation runs before a single byte of the stream: once the 200 and the
    // SSE headers are out, a failure can only be reported as an event in the body.
    const events = this.sessions.stream(actor, sessionId, body.input);
    const iterator = events[Symbol.asyncIterator]();
    const first = await iterator.next();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Nothing between here and the browser may buffer a stream whose point is to
    // arrive gradually.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      for (let step = first; !step.done; step = await iterator.next()) {
        res.write(`data: ${JSON.stringify(presentEvent(step.value))}\n\n`);
      }
      res.write('event: done\ndata: {}\n\n');
    } catch (err) {
      const message = err instanceof DomainError ? err.message : 'The assistant could not finish this turn.';
      res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
    }
    res.end();
  }

  /**
   * A per-user ceiling on turns, on top of the global per-IP limiter.
   *
   * Per user rather than per IP because the cost being bounded is model spend, and
   * a whole office shares one address — one person's runaway script would
   * otherwise lock out everybody sitting next to them.
   */
  private async assertWithinBudget(actor: Actor): Promise<void> {
    const max = this.config.get('COPILOT_RATE_LIMIT_PER_MIN', { infer: true });
    const allowed = await this.limiter.hit(RateLimiter.key('copilot', actor.userId, 'turn', 60), max, 60);
    if (!allowed) {
      throw new DomainError(
        'COPILOT_RATE_LIMITED',
        'Too many copilot messages. Wait a moment and try again.',
        429,
        undefined,
        { 'Retry-After': '60' },
      );
    }
  }
}
