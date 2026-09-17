import type { CookieOptions, Request, Response } from 'express';
import { IdentityErrors } from '../domain/errors';

export const REFRESH_COOKIE = 'sf_refresh';

/**
 * The refresh token never reaches JavaScript: HttpOnly, Secure, SameSite=Strict, and
 * scoped to /auth so it is only sent to refresh and logout (docs/adr/0009).
 */
const baseOptions: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/auth',
};

export function setRefreshCookie(res: Response, token: string, expires: Date): void {
  res.cookie(REFRESH_COOKIE, token, { ...baseOptions, expires });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, baseOptions);
}

export function readRefreshCookie(req: Request): string | undefined {
  const value = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  return value || undefined;
}

/**
 * Cross-site request defence for the cookie-authenticated endpoints. Browsers send
 * `Origin` on cross-origin POSTs, so a foreign origin is refused before the token is
 * touched. Requests without `Origin` come from non-browser clients, which cannot be
 * made to carry someone else's cookie, and are allowed.
 */
export function assertAllowedOrigin(req: Request, allowed: string[]): void {
  const origin = req.header('origin');
  if (origin && !allowed.includes(origin)) throw IdentityErrors.forbiddenOrigin();
}
