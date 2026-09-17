import { Body, Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { errorEnvelopeSchema } from '@stockflow/contracts';
import request from 'supertest';
import { z } from 'zod';
import { DomainError } from '../../src/platform/errors/domain-error';
import { Public } from '../../src/platform/http/public.decorator';
import { ZodValidationPipe } from '../../src/platform/validation/zod-validation.pipe';
import { createTestApp } from '../helpers/test-app';

const echoSchema = z.object({ name: z.string().min(1), qty: z.number().int().positive() });

@Public()
@Controller('__test')
class ProbeController {
  @Post('echo')
  echo(@Body(new ZodValidationPipe(echoSchema)) body: z.infer<typeof echoSchema>) {
    return body;
  }

  @Get('domain-error')
  domain(): never {
    throw new DomainError('EMAIL_ALREADY_EXISTS', 'Email already exists.', 409);
  }

  @Get('crash')
  crash(): never {
    throw new Error('secret internal detail');
  }
}

describe('error envelope', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({ extra: { controllers: [ProbeController] } });
  });
  afterAll(() => app.close());

  it('renders validation failures as 400 with per-field details', async () => {
    const res = await request(app.getHttpServer()).post('/__test/echo').send({ name: '', qty: 0 });

    expect(res.status).toBe(400);
    expect(errorEnvelopeSchema.parse(res.body).error.code).toBe('BAD_REQUEST');
    const paths = (res.body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'qty']));
  });

  it('carries x-request-id on every response, including errors', async () => {
    const res = await request(app.getHttpServer()).post('/__test/echo').send({});
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses a well-formed inbound request id', async () => {
    const res = await request(app.getHttpServer()).get('/health').set('x-request-id', 'trace-abc-123');
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('renders a DomainError with its own code and status', async () => {
    const res = await request(app.getHttpServer()).get('/__test/domain-error');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'EMAIL_ALREADY_EXISTS', message: 'Email already exists.' },
    });
  });

  it('renders unknown routes as a 404 envelope', async () => {
    const res = await request(app.getHttpServer()).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(errorEnvelopeSchema.parse(res.body).error.code).toBe('NOT_FOUND');
  });

  it('hides internal error details from the client', async () => {
    const res = await request(app.getHttpServer()).get('/__test/crash');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
