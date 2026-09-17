export const ORG_TYPES = ['buyer', 'internal'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const ROLES = ['buyer', 'buyer_admin', 'ops', 'ops_admin'] as const;
export type Role = (typeof ROLES)[number];

/** Which roles may exist in which organisation type (mirrors chk_role_matches_org_type). */
const ROLES_BY_ORG_TYPE: Record<OrgType, readonly Role[]> = {
  internal: ['ops', 'ops_admin'],
  buyer: ['buyer', 'buyer_admin'],
};

export const roleAllowedFor = (orgType: OrgType, role: Role): boolean =>
  ROLES_BY_ORG_TYPE[orgType].includes(role);

export const isOpsRole = (role: Role): boolean => role === 'ops' || role === 'ops_admin';
