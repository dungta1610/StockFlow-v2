import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import type { Env } from '../../../platform/config/env.schema';
import { AccessTokenService } from '../application/ports/access-token.service';
import type { Actor } from '../domain/actor';
import { ORG_TYPES, ROLES } from '../domain/role';

/** Compact claims; validated on the way back in so a well-signed but odd token is still refused. */
const claimsSchema = z.object({
  sub: z.uuid(),
  org: z.uuid(),
  ot: z.enum(ORG_TYPES),
  roles: z.array(z.enum(ROLES)).min(1),
});

@Injectable()
export class JwtAccessTokenService extends AccessTokenService {
  private readonly ttl: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    super();
    this.ttl = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
  }

  async sign(actor: Actor): Promise<{ token: string; expiresIn: number }> {
    const token = await this.jwt.signAsync(
      { sub: actor.userId, org: actor.orgId, ot: actor.orgType, roles: actor.roles },
      { expiresIn: this.ttl },
    );
    return { token, expiresIn: this.ttl };
  }

  async verify(token: string): Promise<Actor | null> {
    try {
      const claims = claimsSchema.parse(await this.jwt.verifyAsync(token, { algorithms: ['HS256'] }));
      return { userId: claims.sub, orgId: claims.org, orgType: claims.ot, roles: claims.roles };
    } catch {
      return null;
    }
  }
}
