import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type LoginRequest, loginRequestSchema } from '@stockflow/contracts';
import type { Request, Response } from 'express';
import type { Env } from '../../../platform/config/env.schema';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { GetCurrentSessionUseCase } from '../application/use-cases/get-current-session.use-case';
import { LoginUseCase } from '../application/use-cases/login.use-case';
import { LogoutUseCase } from '../application/use-cases/logout.use-case';
import { RefreshSessionUseCase } from '../application/use-cases/refresh-session.use-case';
import type { Actor } from '../domain/actor';
import { CurrentActor, Public } from './auth.decorators';
import { presentMembership, presentSession, presentUser } from './presenters';
import {
  assertAllowedOrigin,
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from './refresh-cookie';

@Controller('auth')
export class AuthController {
  private readonly allowedOrigins: string[];

  constructor(
    private readonly uow: UnitOfWork,
    private readonly loginUseCase: LoginUseCase,
    private readonly refreshUseCase: RefreshSessionUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly currentSession: GetCurrentSessionUseCase,
    config: ConfigService<Env, true>,
  ) {
    this.allowedOrigins = config.get('CORS_ORIGINS', { infer: true });
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.loginUseCase.execute(
      this.uow.db,
      { email: body.email, password: body.password, orgCode: body.org_code },
      req.ip ?? 'unknown',
    );
    setRefreshCookie(res, session.refreshToken, session.refreshExpiresAt);
    return { data: presentSession(session) };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertAllowedOrigin(req, this.allowedOrigins);
    try {
      const session = await this.refreshUseCase.execute(this.uow.db, readRefreshCookie(req));
      setRefreshCookie(res, session.refreshToken, session.refreshExpiresAt);
      return { data: presentSession(session) };
    } catch (err) {
      clearRefreshCookie(res);
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    assertAllowedOrigin(req, this.allowedOrigins);
    await this.logoutUseCase.execute(this.uow.db, readRefreshCookie(req));
    clearRefreshCookie(res);
  }

  @Get('me')
  async me(@CurrentActor() actor: Actor) {
    const { user, actingAs } = await this.currentSession.execute(this.uow.db, actor);
    return { data: { user: presentUser(user), acting_as: presentMembership(actingAs) } };
  }
}
