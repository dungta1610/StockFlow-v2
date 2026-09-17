import { validateEnv } from '../../src/platform/config/env.schema';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a-real-secret-that-is-long-enough-0123456789',
};

describe('environment validation', () => {
  it('fails fast, naming each missing variable', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL[\s\S]*JWT_SECRET/);
  });

  it('rejects a short JWT secret', () => {
    expect(() => validateEnv({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('refuses the published placeholder secret in production', () => {
    const placeholder = 'dev-only-insecure-jwt-secret-change-me-0123456789';
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: placeholder })).toThrow(
      /placeholder secret/,
    );
    // …but allows it for local development.
    expect(validateEnv({ ...base, NODE_ENV: 'development', JWT_SECRET: placeholder }).JWT_SECRET).toBe(placeholder);
  });

  it('parses CORS_ORIGINS into a list', () => {
    expect(validateEnv({ ...base, CORS_ORIGINS: ' http://a.test , http://b.test,' }).CORS_ORIGINS).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });
});
