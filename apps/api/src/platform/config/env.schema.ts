import { z } from 'zod';

/**
 * Environment contract for the API, validated at boot (fail-fast): a
 * misconfigured process refuses to start instead of failing on first use.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().url(),
  /** Per-connection guards; see docs/adr/0004. */
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),

  REDIS_URL: z.string().url(),

  /** Global limiter, same defaults StockFlow used: 100 requests / minute per client+path. */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  /** HS256 signing key for access tokens. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),
  /** Absolute session lifetime: refreshing never extends a login beyond this. */
  JWT_SESSION_MAX_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 3600),

  /** Failed logins allowed per account / per client IP within the window. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_MAX_ATTEMPTS_PER_IP: z.coerce.number().int().positive().default(20),
  LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),

  /** How long a new order holds its stock before the expiry sweep may release it. */
  ORDER_RESERVATION_TTL_MINUTES: z.coerce.number().int().positive().default(30),

  /** How often the outbox relay polls for pending events (docs/adr/0017). */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  /**
   * Events claimed per poll; bounds how long one poll holds its transaction open.
   * Capped at 64: each event runs in its own savepoint, and past 64 subtransactions
   * Postgres spills them out of shared memory and every visibility check slows down.
   */
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(64).default(20),
  /** Failed dispatch attempts before an event is marked `dead`. */
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),

  /** How often the reservation-expiry sweep runs (docs/adr/0018). */
  RESERVATION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** Orders swept per run — limits how many ORDERS one run touches, never how many
   *  lines of one order: expiry always settles a whole order or none of it. */
  RESERVATION_SWEEP_BATCH: z.coerce.number().int().positive().default(50),

  /** How long a resolved idempotency key is kept before the cleanup job deletes it. */
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),

  /**
   * Comma-separated browser origins allowed by CORS. Also the allow-list for the
   * cookie-authenticated /auth/refresh and /auth/logout endpoints.
   */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),
});

/** Markers of the placeholder secrets shipped in docker-compose.yml and .env.example. */
const PLACEHOLDER_SECRET = /dev-only|change-me|changeme/i;

/** Production must not run on a secret that is published in this repository. */
const productionSafe = envSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && PLACEHOLDER_SECRET.test(env.JWT_SECRET)) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_SECRET'],
      message: 'a placeholder secret cannot be used in production',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = productionSafe.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}
