import { IdentityErrors } from './errors';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Throws WEAK_PASSWORD unless the plaintext meets the length policy. */
export function assertPasswordPolicy(plain: string): void {
  if (plain.length < PASSWORD_MIN_LENGTH || plain.length > PASSWORD_MAX_LENGTH) {
    throw IdentityErrors.weakPassword();
  }
}
