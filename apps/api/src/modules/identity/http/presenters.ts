import type { MembershipView, OrganizationView, SessionView, UserView } from '@stockflow/contracts';
import type { Session } from '../application/session-issuer';
import type { Organization } from '../domain/organization';
import type { Membership, User } from '../domain/user';

// Domain objects → public JSON (snake_case, as StockFlow's API was).
// Password hashes and token hashes have no field here, so they cannot leak.

export const presentMembership = (m: Membership): MembershipView => ({
  org_id: m.orgId,
  org_code: m.orgCode,
  org_type: m.orgType,
  role: m.role,
});

export const presentUser = (u: User): UserView => ({
  id: u.id,
  email: u.email,
  full_name: u.fullName,
  is_active: u.isActive,
  memberships: u.memberships.map(presentMembership),
  created_at: u.createdAt.toISOString(),
  updated_at: u.updatedAt.toISOString(),
});

export const presentOrganization = (o: Organization): OrganizationView => ({
  id: o.id,
  code: o.code,
  name: o.name,
  type: o.type,
  tax_code: o.taxCode,
  is_active: o.isActive,
  created_at: o.createdAt.toISOString(),
  updated_at: o.updatedAt.toISOString(),
});

export const presentSession = (s: Session): SessionView => ({
  access_token: s.accessToken,
  token_type: 'Bearer',
  expires_in: s.expiresIn,
  user: presentUser(s.user),
  acting_as: presentMembership(s.actingAs),
});
