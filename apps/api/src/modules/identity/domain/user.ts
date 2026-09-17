import type { OrgType, Role } from './role';

export interface Membership {
  orgId: string;
  orgCode: string;
  orgType: OrgType;
  orgIsActive: boolean;
  role: Role;
}

/** A user as the application sees it. The password hash never leaves the repository. */
export interface User {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  memberships: Membership[];
}

/** Ported from StockFlow's user Filter.Normalize(): trim, lower-case email. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
