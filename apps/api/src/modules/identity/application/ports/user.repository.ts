import type { Paging } from '../../../../platform/database/sql';
import type { Tx } from '../../../../platform/database/tx';
import type { OrgScope } from '../../domain/org-scope';
import type { OrgType, Role } from '../../domain/role';
import type { Membership, User } from '../../domain/user';

export type { Paging } from '../../../../platform/database/sql';

/** StockFlow's user Filter, plus an organisation filter. */
export interface UserFilter {
  email?: string;
  fullName?: string;
  role?: Role;
  isActive?: boolean;
  orgId?: string;
}

export interface ScopedUser {
  /** Only the memberships inside the caller's scope. */
  user: User;
  /** True when the account also belongs to organisations the caller cannot see. */
  hasMembershipsOutsideScope: boolean;
}

export interface UserCredentials {
  user: User;
  passwordHash: string;
}

/**
 * Persistence for users and memberships. Every read of organisation-owned data takes
 * an OrgScope; scoped reads return memberships inside the scope only.
 */
export abstract class UserRepository {
  /** For login only: the account, all its memberships, and the stored hash. */
  abstract findCredentialsByEmail(tx: Tx, email: string): Promise<UserCredentials | null>;

  /** Null unless the user has at least one membership inside `scope`. */
  abstract findById(tx: Tx, scope: OrgScope, id: string): Promise<ScopedUser | null>;

  abstract list(tx: Tx, scope: OrgScope, filter: UserFilter, paging: Paging): Promise<User[]>;

  /**
   * The user and one membership, only if the user is active, the membership exists
   * and its organisation is active. Used to (re)issue a session.
   */
  abstract findActiveMembership(
    tx: Tx,
    userId: string,
    orgId: string,
  ): Promise<{ user: User; membership: Membership } | null>;

  /** Throws EMAIL_ALREADY_EXISTS on a duplicate email. */
  abstract create(tx: Tx, data: { email: string; passwordHash: string; fullName: string }): Promise<string>;

  abstract addMembership(
    tx: Tx,
    data: { userId: string; orgId: string; orgType: OrgType; role: Role },
  ): Promise<void>;

  /** Updates account-level fields and always bumps updated_at. */
  abstract updateAccount(
    tx: Tx,
    id: string,
    data: { fullName: string; passwordHash?: string; isActive?: boolean },
  ): Promise<void>;

  abstract updateMembershipRole(tx: Tx, userId: string, orgId: string, role: Role): Promise<void>;
}
