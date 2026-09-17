import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { Env } from '../../platform/config/env.schema';
import { AccessTokenService } from './application/ports/access-token.service';
import { OrganizationRepository } from './application/ports/organization.repository';
import { PasswordHasher } from './application/ports/password-hasher';
import { RefreshTokenRepository } from './application/ports/refresh-token.repository';
import { UserRepository } from './application/ports/user.repository';
import { SessionIssuer } from './application/session-issuer';
import { GetCurrentSessionUseCase } from './application/use-cases/get-current-session.use-case';
import { LoginUseCase } from './application/use-cases/login.use-case';
import { LogoutUseCase } from './application/use-cases/logout.use-case';
import {
  CreateOrganizationUseCase,
  GetOrganizationUseCase,
  ListOrganizationsUseCase,
} from './application/use-cases/organization.use-cases';
import { RefreshSessionUseCase } from './application/use-cases/refresh-session.use-case';
import {
  CreateUserUseCase,
  GetUserUseCase,
  ListUsersUseCase,
  UpdateUserUseCase,
} from './application/use-cases/user.use-cases';
import { AuthController } from './http/auth.controller';
import { OrganizationController } from './http/organization.controller';
import { UserController } from './http/user.controller';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher';
import { JwtAccessTokenService } from './infrastructure/jwt-access-token.service';
import { SqlOrganizationRepository } from './infrastructure/sql-organization.repository';
import { SqlRefreshTokenRepository } from './infrastructure/sql-refresh-token.repository';
import { SqlUserRepository } from './infrastructure/sql-user.repository';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: { algorithm: 'HS256' },
      }),
    }),
  ],
  controllers: [AuthController, OrganizationController, UserController],
  providers: [
    // Ports → adapters
    { provide: UserRepository, useClass: SqlUserRepository },
    { provide: OrganizationRepository, useClass: SqlOrganizationRepository },
    { provide: RefreshTokenRepository, useClass: SqlRefreshTokenRepository },
    { provide: PasswordHasher, useClass: Argon2PasswordHasher },
    { provide: AccessTokenService, useClass: JwtAccessTokenService },
    SessionIssuer,
    LoginUseCase,
    RefreshSessionUseCase,
    LogoutUseCase,
    GetCurrentSessionUseCase,
    CreateOrganizationUseCase,
    ListOrganizationsUseCase,
    GetOrganizationUseCase,
    CreateUserUseCase,
    ListUsersUseCase,
    GetUserUseCase,
    UpdateUserUseCase,
  ],
  // The global auth guards (registered in AppModule) need the token service;
  // pricing and ordering look up customer organisations.
  exports: [AccessTokenService, OrganizationRepository],
})
export class IdentityModule {}
