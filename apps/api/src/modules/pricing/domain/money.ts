import { badRequest } from '../../../platform/errors/domain-error';

/**
 * An amount of money in integer minor units (1/100). There is no path from a
 * JavaScript `number` with a fractional part to a Money: amounts enter as decimal
 * strings (API bodies, Postgres `numeric`) and leave the same way.
 *
 * v1 has a single currency, enforced by CHECK constraints, so Money carries none.
 * Adding currencies means adding it here together with the database changes — a
 * half-built multi-currency type would be worse than none.
 */
export class Money {
  static readonly ZERO = new Money(0n);

  private constructor(readonly minor: bigint) {}

  static fromMinor(minor: bigint): Money {
    return new Money(minor);
  }

  /**
   * An amount from an API request: non-negative, at most 16 integer digits and two
   * decimals — the range of numeric(18,2). No signs, exponents, separators or spaces.
   */
  static parse(value: string): Money {
    if (typeof value !== 'string' || !API_AMOUNT.test(value)) {
      throw badRequest('INVALID_AMOUNT', 'Amounts are decimal strings with at most two decimals.', {
        value,
      });
    }
    return Money.fromDb(value);
  }

  /** A Postgres `numeric` as the driver returns it (a string, possibly signed). */
  static fromDb(value: string): Money {
    const m = DB_NUMERIC.exec(value);
    if (!m) throw new Error(`Invalid numeric value: ${JSON.stringify(value)}`);
    const [, sign, whole, frac = ''] = m;
    const minor = BigInt(whole!) * 100n + BigInt((frac + '00').slice(0, 2));
    return new Money(sign === '-' ? -minor : minor);
  }

  plus(other: Money): Money {
    return new Money(this.minor + other.minor);
  }

  /** Multiplies by a whole quantity. */
  times(quantity: number): Money {
    if (!Number.isSafeInteger(quantity)) throw new Error(`Invalid quantity: ${quantity}`);
    return new Money(this.minor * BigInt(quantity));
  }

  compare(other: Money): number {
    return this.minor < other.minor ? -1 : this.minor > other.minor ? 1 : 0;
  }

  equals(other: Money): boolean {
    return this.minor === other.minor;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  /** Decimal string with exactly two fraction digits, e.g. "125000.00". */
  toString(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const whole = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${whole}.${frac}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

const API_AMOUNT = /^\d{1,16}(\.\d{1,2})?$/;
const DB_NUMERIC = /^(-?)(\d+)(?:\.(\d{1,2})0*)?$/;
