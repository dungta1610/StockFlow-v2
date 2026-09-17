export abstract class PasswordHasher {
  abstract hash(plain: string): Promise<string>;
  /** False for a wrong password and for a malformed stored hash. */
  abstract verify(storedHash: string, plain: string): Promise<boolean>;
}
