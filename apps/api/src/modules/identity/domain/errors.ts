import { DomainError, conflict, notFound, unauthorized } from '../../../platform/errors/domain-error';

/** Identity failures. Codes are part of the public API contract. */
export const IdentityErrors = {
  /** Same code and message for unknown email, wrong password and inactive user. */
  invalidCredentials: () => new DomainError('INVALID_CREDENTIALS', 'Invalid email or password.', 401),
  loginLocked: () =>
    new DomainError('LOGIN_LOCKED', 'Too many failed login attempts. Try again later.', 429),
  /** JwtAuthGuard: no bearer scheme, or no token after it. */
  missingToken: () => unauthorized('UNAUTHORIZED', 'Missing bearer token.'),
  /** JwtAuthGuard: the token does not verify (bad signature, expired, revoked). */
  invalidToken: () => unauthorized('UNAUTHORIZED', 'Invalid or expired token.'),
  orgSelectionRequired: (orgCodes: string[]) =>
    new DomainError(
      'ORG_SELECTION_REQUIRED',
      'This account belongs to several organisations; choose one with org_code.',
      400,
      { org_codes: orgCodes },
    ),
  refreshInvalid: () => new DomainError('REFRESH_TOKEN_INVALID', 'Session expired. Sign in again.', 401),
  sessionInvalid: () => new DomainError('UNAUTHORIZED', 'Session is no longer valid.', 401),
  forbiddenOrigin: () => new DomainError('FORBIDDEN_ORIGIN', 'Request origin is not allowed.', 403),
  emailAlreadyExists: () => conflict('EMAIL_ALREADY_EXISTS', 'User email already exists.'),
  orgCodeAlreadyExists: () => conflict('ORG_CODE_ALREADY_EXISTS', 'Organisation code already exists.'),
  roleNotAllowedForOrg: () =>
    new DomainError('ROLE_NOT_ALLOWED_FOR_ORG', 'This role cannot be assigned in this organisation.', 400),
  orgIdRequired: () =>
    new DomainError(
      'ORG_ID_REQUIRED',
      'The user belongs to several organisations in your scope; specify org_id.',
      400,
    ),
  weakPassword: () =>
    new DomainError('WEAK_PASSWORD', 'Password must be between 8 and 128 characters.', 400),
  userNotFound: () => notFound('User'),
  organizationNotFound: () => notFound('Organization'),
};
