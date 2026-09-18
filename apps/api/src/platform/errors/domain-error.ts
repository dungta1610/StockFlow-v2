/**
 * An expected business failure. Carries a stable `code` clients can branch on
 * and the HTTP status the exception filter renders it with. Modules throw these;
 * they never build HTTP responses themselves.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
    /** Response headers that belong with this failure, e.g. `Retry-After`. */
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (what: string) => new DomainError('NOT_FOUND', `${what} not found.`, 404);

export const forbidden = (message = 'You do not have access to this resource.') =>
  new DomainError('FORBIDDEN', message, 403);

export const conflict = (code: string, message: string) => new DomainError(code, message, 409);

export const badRequest = (code: string, message: string, details?: unknown) =>
  new DomainError(code, message, 400, details);
