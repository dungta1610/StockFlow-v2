import type { MembershipView, SessionView } from '@stockflow/contracts';
import { describe, expect, it } from 'vitest';
import { navItemsFor } from '../src/app-layout';
import { canManageUsers, isOps, isOpsAdmin } from '../src/features/auth/session';
import { rolesForOrgType } from '../src/features/users/users-api';

const session = (acting_as: MembershipView): SessionView =>
  ({
    access_token: 't',
    token_type: 'Bearer',
    expires_in: 900,
    acting_as,
  }) as SessionView;

const buyer = session({ org_id: 'o1', org_code: 'ACME', org_type: 'buyer', role: 'buyer' });
const buyerAdmin = session({ org_id: 'o1', org_code: 'ACME', org_type: 'buyer', role: 'buyer_admin' });
const ops = session({ org_id: 'o0', org_code: 'STOCKFLOW', org_type: 'internal', role: 'ops' });
const opsAdmin = session({ org_id: 'o0', org_code: 'STOCKFLOW', org_type: 'internal', role: 'ops_admin' });

describe('role checks', () => {
  it('isOps is true only inside the internal organisation', () => {
    expect(isOps(buyer)).toBe(false);
    expect(isOps(buyerAdmin)).toBe(false);
    expect(isOps(ops)).toBe(true);
    expect(isOps(opsAdmin)).toBe(true);
  });

  it('isOpsAdmin additionally requires the ops_admin role', () => {
    expect(isOpsAdmin(ops)).toBe(false);
    expect(isOpsAdmin(opsAdmin)).toBe(true);
  });

  it('canManageUsers matches exactly ops_admin and buyer_admin — the roles the /users controller lets through', () => {
    expect(canManageUsers(buyer)).toBe(false);
    expect(canManageUsers(buyerAdmin)).toBe(true);
    expect(canManageUsers(ops)).toBe(false);
    expect(canManageUsers(opsAdmin)).toBe(true);
  });
});

describe('navItemsFor — hides screens the actor\'s role cannot reach', () => {
  const labels = (s: SessionView) => navItemsFor(s).map((i) => i.label);

  it('a plain buyer sees only the buyer-visible screens', () => {
    expect(labels(buyer)).toEqual(['Orders', 'Products', 'Warehouses']);
    // The copilot reads ops-scoped data and files stock proposals; a buyer has no
    // route to it, and the API refuses them anyway.
    expect(labels(buyer)).not.toContain('Copilot');
  });

  it('a buyer_admin additionally sees Users (their own organisation, scoped by the API)', () => {
    expect(labels(buyerAdmin)).toEqual(['Orders', 'Products', 'Warehouses', 'Users']);
  });

  it('ops sees the ops-only screens but not Users (ops alone cannot manage accounts)', () => {
    const items = labels(ops);
    expect(items).toContain('Reservations');
    expect(items).toContain('Inventory');
    expect(items).toContain('Price lists');
    expect(items).toContain('Organisations');
    expect(items).toContain('Copilot');
    expect(items).not.toContain('Users');
  });

  it('ops_admin sees every screen', () => {
    expect(labels(opsAdmin)).toEqual([
      'Orders',
      'Products',
      'Warehouses',
      'Reservations',
      'Inventory',
      'Price lists',
      'Organisations',
      'Copilot',
      'Users',
    ]);
  });
});

describe('rolesForOrgType — mirrors the API\'s role/org-type pairing so the form cannot offer a role the server refuses', () => {
  it('offers only ops roles for an internal organisation', () => {
    expect(rolesForOrgType('internal')).toEqual(['ops', 'ops_admin']);
  });

  it('offers only buyer roles for a buyer organisation', () => {
    expect(rolesForOrgType('buyer')).toEqual(['buyer', 'buyer_admin']);
  });
});
