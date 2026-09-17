import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

const INBOUND_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Tags each request with an id (reusing a well-formed inbound `x-request-id`),
 * echoes it back, and logs method, path, status and latency when the response
 * finishes.
 *
 * A middleware rather than an interceptor (AI-Harness used one): interceptors
 * never run when a guard rejects the request, so 401/403/429 responses would go
 * out with no request id and no log line.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header('x-request-id');
    const id = inbound && INBOUND_ID.test(inbound) ? inbound : randomUUID();
    req.id = id;
    res.setHeader('x-request-id', id);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      this.logger.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} ${ms.toFixed(1)}ms [${id}]`);
    });
    next();
  }
}
