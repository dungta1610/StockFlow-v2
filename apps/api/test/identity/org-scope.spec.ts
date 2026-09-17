import type { Actor } from '../../src/modules/identity/domain/actor';
import {
  assertOrgInScope,
  identityScopeOf,
  orgScopeOf,
  scopeIncludes,
} from '../../src/modules/identity/domain/org-scope';

const actor = (orgType: Actor['orgType'], ...roles: Actor['roles']): Actor => ({
  userId: 'u1',
  orgId: 'org-self',
  orgType,
  roles,
});

describe('orgScopeOf (commerce data)', () => {
  it('gives a buyer only their own organisation', () => {
    expect(orgScopeOf(actor('buyer', 'buyer'))).toEqual({ kind: 'single', orgId: 'org-self' });
    expect(orgScopeOf(actor('buyer', 'buyer_admin'))).toEqual({ kind: 'single', orgId: 'org-self' });
  });

  it('gives internal ops every buyer organisation', () => {
    expect(orgScopeOf(actor('internal', 'ops'))).toEqual({ kind: 'all-buyers' });
    expect(orgScopeOf(actor('internal', 'ops_admin'))).toEqual({ kind: 'all-buyers' });
  });

  it('does not widen scope just because the actor sits in the internal org', () => {
    // Being in the right organisation without an ops role grants nothing extra.
    expect(orgScopeOf(actor('internal'))).toEqual({ kind: 'single', orgId: 'org-self' });
  });

  it('does not widen scope for an ops role outside the internal org', () => {
    // The database forbids this combination; the domain rule must not rely on that alone.
    expect(orgScopeOf(actor('buyer', 'ops_admin'))).toEqual({ kind: 'single', orgId: 'org-self' });
  });
});

describe('identityScopeOf (organisations and members)', () => {
  it('lets internal ops see every organisation, including internal', () => {
    expect(identityScopeOf(actor('internal', 'ops_admin'))).toEqual({ kind: 'all' });
  });

  it('limits buyers to their own organisation', () => {
    expect(identityScopeOf(actor('buyer', 'buyer_admin'))).toEqual({ kind: 'single', orgId: 'org-self' });
  });
});

describe('assertOrgInScope', () => {
  const buyer = { id: 'org-b', type: 'buyer' as const };
  const internal = { id: 'org-i', type: 'internal' as const };

  it('single scope accepts only its own organisation', () => {
    expect(() => assertOrgInScope({ kind: 'single', orgId: 'org-b' }, buyer)).not.toThrow();
    expect(() => assertOrgInScope({ kind: 'single', orgId: 'org-a' }, buyer)).toThrow();
  });

  it('all-buyers accepts any buyer but never the internal organisation', () => {
    expect(() => assertOrgInScope({ kind: 'all-buyers' }, buyer)).not.toThrow();
    expect(() => assertOrgInScope({ kind: 'all-buyers' }, internal)).toThrow();
  });

  it('all accepts every organisation', () => {
    expect(scopeIncludes({ kind: 'all' }, internal)).toBe(true);
    expect(scopeIncludes({ kind: 'all' }, buyer)).toBe(true);
  });

  it('reports an out-of-scope organisation as not found, not forbidden', () => {
    try {
      assertOrgInScope({ kind: 'single', orgId: 'org-a' }, buyer);
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    }
  });
});
