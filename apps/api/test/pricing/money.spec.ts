import { Money } from '../../src/modules/pricing/domain/money';

describe('Money', () => {
  it('round-trips a numeric(18,2) value exactly', () => {
    for (const v of ['0.00', '0.01', '1234.56', '9999999999999999.99', '125000.00']) {
      expect(Money.fromDb(v).toString()).toBe(v);
    }
  });

  it('normalises the scale to two decimals', () => {
    expect(Money.parse('10').toString()).toBe('10.00');
    expect(Money.parse('10.5').toString()).toBe('10.50');
  });

  it('stores integer minor units — no floating point anywhere', () => {
    expect(Money.parse('0.10').minor).toBe(10n);
    expect(Money.parse('0.20').minor).toBe(20n);
    // 0.1 + 0.2 is exact here; with floats it is 0.30000000000000004.
    expect(Money.parse('0.10').plus(Money.parse('0.20')).toString()).toBe('0.30');
  });

  it('multiplies by an integer quantity exactly, beyond float precision', () => {
    expect(Money.parse('19.99').times(3).toString()).toBe('59.97');
    expect(Money.parse('9999999999999.99').times(1000).toString()).toBe('9999999999999990.00');
  });

  it('rejects a fractional or unsafe quantity', () => {
    expect(() => Money.parse('1.00').times(1.5)).toThrow();
    expect(() => Money.parse('1.00').times(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it.each(['', 'abc', '1.234', '-1.00', '1e3', ' 1.00', '1,000.00', '12345678901234567.00'])(
    'rejects %j as an API amount',
    (v) => {
      expect(() => Money.parse(v)).toThrow();
    },
  );

  it('never accepts a JavaScript number', () => {
    // @ts-expect-error — the API is string-only by design
    expect(() => Money.parse(1.5)).toThrow();
    expect(() => Money.parse('1.005')).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT', status: 400 }));
  });

  it('compares values', () => {
    expect(Money.parse('2.00').compare(Money.parse('10.00'))).toBeLessThan(0);
    expect(Money.parse('2.00').equals(Money.fromMinor(200n))).toBe(true);
  });
});
