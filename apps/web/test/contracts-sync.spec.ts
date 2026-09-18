import { errorEnvelopeSchema } from '@stockflow/contracts';
import { describe, expect, it } from 'vitest';

/**
 * Response bodies actually parsed through packages/contracts' zod schemas — against
 * a running API. This intentionally covers only `errorEnvelopeSchema`, because that
 * is the only response-shaped zod schema the contracts package exports: every `*View`
 * type (OrderView, UserView, AuditLogView, ...) is a plain TypeScript interface,
 * checked at compile time only, with no runtime validator. There is nothing else to
 * parse a success response through, so this test does not attempt one; extending it
 * would mean inventing a schema packages/contracts does not have, which is not this
 * test's job.
 *
 * Skipped unless E2E_API_URL points at a live API (same convention as
 * e2e/ops-order-lifecycle.spec.ts), so `pnpm test` stays hermetic by default.
 */
const API_URL = process.env.E2E_API_URL;
const SEED_PASSWORD = process.env.E2E_SEED_PASSWORD ?? 'ChangeMe-123!';

describe.skipIf(!API_URL)('contracts-sync: error envelope', () => {
  it('a real 404 from the API parses through errorEnvelopeSchema', async () => {
    const login = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops.admin@stockflow.local', password: SEED_PASSWORD }),
    });
    const loginBody = (await login.json()) as { data: { access_token: string } };

    const res = await fetch(`${API_URL}/orders/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${loginBody.data.access_token}` },
    });
    const body: unknown = await res.json();
    expect(res.status).toBe(404);
    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.code).toBe('ORDER_NOT_FOUND');
  });
});
