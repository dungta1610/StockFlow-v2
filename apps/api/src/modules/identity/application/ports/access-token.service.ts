import type { Actor } from '../../domain/actor';

export abstract class AccessTokenService {
  abstract sign(actor: Actor): Promise<{ token: string; expiresIn: number }>;
  /** Null for any invalid, expired or malformed token. */
  abstract verify(token: string): Promise<Actor | null>;
}
