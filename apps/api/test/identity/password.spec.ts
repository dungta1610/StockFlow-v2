import { Argon2PasswordHasher } from '../../src/modules/identity/infrastructure/argon2-password-hasher';
import { assertPasswordPolicy } from '../../src/modules/identity/domain/password';

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher();

  it('produces an argon2id hash that is not the plaintext', async () => {
    const h = await hasher.hash('s3cret-password');
    expect(h).not.toContain('s3cret-password');
    expect(h.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const h = await hasher.hash('s3cret-password');
    expect(await hasher.verify(h, 's3cret-password')).toBe(true);
    expect(await hasher.verify(h, 'S3cret-password')).toBe(false);
  });

  it('salts: hashing the same input twice gives different hashes', async () => {
    expect(await hasher.hash('same-input')).not.toBe(await hasher.hash('same-input'));
  });

  it('treats a malformed stored hash as a failed verification, not a crash', async () => {
    expect(await hasher.verify('not-a-hash', 'anything')).toBe(false);
  });
});

describe('password policy', () => {
  it('rejects passwords shorter than 8 or longer than 128 characters', () => {
    expect(() => assertPasswordPolicy('1234567')).toThrow();
    expect(() => assertPasswordPolicy('x'.repeat(129))).toThrow();
    expect(() => assertPasswordPolicy('12345678')).not.toThrow();
    expect(() => assertPasswordPolicy('x'.repeat(128))).not.toThrow();
  });
});
