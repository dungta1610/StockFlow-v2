import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ErrorEnvelope } from '@stockflow/contracts';
import type { Request, Response } from 'express';
import { DomainError } from './domain-error';

/**
 * Renders every failure as `{ error: { code, message, details } }` (ported from
 * AI-Harness). Adds DomainError support and codes for 409 / 429.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const { status, body } = normalize(exception);
    const label = `${req.method} ${req.originalUrl} -> ${status} ${body.error.code} [${req.id ?? '-'}]`;

    if (status >= 500) {
      this.logger.error(label, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(label);
    }

    // A streaming handler already flushed headers; a JSON body can no longer be sent.
    if (res.headersSent) {
      res.end();
      return;
    }
    if (exception instanceof DomainError && exception.headers) res.set(exception.headers);
    res.status(status).json(body);
  }
}

function normalize(exception: unknown): { status: number; body: ErrorEnvelope } {
  if (exception instanceof DomainError) {
    return {
      status: exception.status,
      body: {
        error: { code: exception.code, message: exception.message, details: exception.details },
      },
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const { message, details, code } = extract(exception.getResponse());
    return { status, body: { error: { code: code ?? codeForStatus(status), message, details } } };
  }

  // Internal error text is logged, never sent to the client.
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } },
  };
}

function extract(response: string | object): { message: string; details?: unknown; code?: string } {
  if (typeof response === 'string') return { message: response };
  const obj = response as Record<string, unknown>;
  const raw = obj.message;
  const message = Array.isArray(raw)
    ? raw.join('; ')
    : typeof raw === 'string'
      ? raw
      : 'Request failed.';
  return {
    message,
    details: obj.details,
    code: typeof obj.code === 'string' ? obj.code : undefined,
  };
}

function codeForStatus(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'UNPROCESSABLE_ENTITY';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'TOO_MANY_REQUESTS';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR';
  }
}
