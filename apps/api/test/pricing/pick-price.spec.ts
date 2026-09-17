import { Money } from '../../src/modules/pricing/domain/money';
import { type PriceCandidate, pickPrice } from '../../src/modules/pricing/domain/pick-price';

const AT = new Date('2026-06-01T00:00:00Z');
const BASE = Money.parse('60000');
const CUSTOMER = 'org-a';

let seq = 0;
const cand = (over: Partial<Omit<PriceCandidate, 'unitPrice'>> & { unitPrice: string }): PriceCandidate => ({
  itemId: `item-${++seq}`,
  listId: 'list-default',
  listOrgId: null,
  priority: 0,
  validFrom: new Date('2026-01-01T00:00:00Z'),
  validTo: null,
  status: 'active',
  minQty: 1,
  ...over,
  unitPrice: Money.parse(over.unitPrice),
});

const pick = (cands: PriceCandidate[], qty: number, at = AT) => pickPrice(cands, CUSTOMER, qty, at, BASE);

describe('pickPrice — quantity tiers', () => {
  const tiers = [
    cand({ minQty: 1, unitPrice: '50000' }),
    cand({ minQty: 50, unitPrice: '45000' }),
    cand({ minQty: 200, unitPrice: '40000' }),
  ];

  it.each([
    [1, '50000.00', 1],
    [49, '50000.00', 1],
    [50, '45000.00', 50],
    [199, '45000.00', 50],
    [200, '40000.00', 200],
    [1000, '40000.00', 200],
  ])('qty %i → %s (tier from %i)', (qty, price, tier) => {
    const r = pick(tiers, qty);
    expect(r.unitPrice.toString()).toBe(price);
    expect(r.minQtyApplied).toBe(tier);
    expect(r.sourceKind).toBe('default_list');
  });

  it('reports which row priced it', () => {
    expect(pick(tiers, 60).sourceId).toBe(tiers[1]!.itemId);
  });

  it.each([0, -1, 1.5])('rejects quantity %s', (qty) => {
    expect(() => pick(tiers, qty)).toThrow();
  });
});

describe('pickPrice — which list applies', () => {
  it('a contract list for the customer beats the default list, even at lower priority', () => {
    const r = pick(
      [
        cand({ listId: 'default', priority: 99, unitPrice: '50000' }),
        cand({ listId: 'contract', listOrgId: CUSTOMER, priority: 0, unitPrice: '42000' }),
      ],
      1,
    );
    expect(r).toMatchObject({ sourceKind: 'contract', priceListId: 'contract' });
    expect(r.unitPrice.toString()).toBe('42000.00');
  });

  it('ignores another customer’s contract list', () => {
    const r = pick([cand({ listId: 'other', listOrgId: 'org-b', unitPrice: '1' })], 1);
    expect(r.sourceKind).toBe('base_price');
  });

  it('ignores archived lists', () => {
    const r = pick([cand({ listOrgId: CUSTOMER, status: 'archived', unitPrice: '1' })], 1);
    expect(r.sourceKind).toBe('base_price');
  });

  it('ignores lists outside their validity window (valid_to is exclusive)', () => {
    const expired = cand({ listId: 'expired', validTo: AT, unitPrice: '1' });
    const future = cand({ listId: 'future', validFrom: new Date(AT.getTime() + 1), unitPrice: '2' });
    const startsNow = cand({ listId: 'starts-now', validFrom: AT, unitPrice: '3' });
    expect(pick([expired, future], 1).sourceKind).toBe('base_price');
    expect(pick([expired, future, startsNow], 1).priceListId).toBe('starts-now');
  });

  it('falls through to the next list when a list has no tier small enough', () => {
    // The contract only prices orders of 100+; an order of 10 uses the default list.
    const r = pick(
      [
        cand({ listId: 'contract', listOrgId: CUSTOMER, minQty: 100, unitPrice: '30000' }),
        cand({ listId: 'default', minQty: 1, unitPrice: '50000' }),
      ],
      10,
    );
    expect(r.priceListId).toBe('default');
  });

  it('prefers higher priority, then the newest valid_from', () => {
    const older = cand({ listId: 'older', priority: 5, validFrom: new Date('2026-01-01Z'), unitPrice: '1' });
    const newer = cand({ listId: 'newer', priority: 5, validFrom: new Date('2026-03-01Z'), unitPrice: '2' });
    const low = cand({ listId: 'low', priority: 1, validFrom: new Date('2026-05-01Z'), unitPrice: '3' });
    expect(pick([older, low, newer], 1).priceListId).toBe('newer');
  });

  it('never mixes tiers from two lists', () => {
    // The chosen list's best tier for qty 60 is its min_qty 1 row, even though another
    // list has a cheaper min_qty 50 row.
    const r = pick(
      [
        cand({ listId: 'a', listOrgId: CUSTOMER, minQty: 1, unitPrice: '48000' }),
        cand({ listId: 'b', minQty: 50, unitPrice: '10000' }),
      ],
      60,
    );
    expect(r).toMatchObject({ priceListId: 'a', minQtyApplied: 1 });
  });

  it('falls back to the base price with no source row', () => {
    const r = pick([], 7);
    expect(r).toEqual({
      unitPrice: BASE,
      sourceKind: 'base_price',
      sourceId: null,
      priceListId: null,
      minQtyApplied: 1,
    });
  });
});

describe('pickPrice — determinism', () => {
  it('breaks a full tie by list id, whatever order the rows arrive in', () => {
    const tied = ['list-c', 'list-a', 'list-b'].map((listId) =>
      cand({ listId, priority: 3, validFrom: new Date('2026-02-01Z'), unitPrice: listId.slice(-1) === 'a' ? '1' : '2' }),
    );
    for (let i = 0; i < 50; i++) {
      const shuffled = [...tied].sort(() => Math.random() - 0.5);
      expect(pick(shuffled, 1).priceListId).toBe('list-a');
    }
  });
});
