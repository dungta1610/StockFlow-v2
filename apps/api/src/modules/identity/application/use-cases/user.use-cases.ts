import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../../platform/database/tx';
import { forbidden } from '../../../../platform/errors/domain-error';
import { type Actor, assertRole } from '../../domain/actor';
import { IdentityErrors } from '../../domain/errors';
import { identityScopeOf } from '../../domain/org-scope';
import { assertPasswordPolicy } from '../../domain/password';
import { type Role, roleAllowedFor } from '../../domain/role';
import type { User } from '../../domain/user';
import { OrganizationRepository } from '../ports/organization.repository';
import { PasswordHasher } from '../ports/password-hasher';
import { RefreshTokenRepository } from '../ports/refresh-token.repository';
import { type Paging, type UserFilter, UserRepository } from '../ports/user.repository';

// Ported from StockFlow module/user/biz (create, get, list, update), now scoped to
// organisations. Only ops_admin and buyer_admin may call them; the scope limits a
// buyer admin to their own organisation.

const ADMIN_ROLES = ['ops_admin', 'buyer_admin'] as const;

export interface CreateUserInput {
  email: string;
  password: string;
  fullName: string;
  orgId: string;
  role: Role;
}

@Injectable()
export class CreateUserUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly orgs: OrganizationRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async execute(tx: Tx, actor: Actor, input: CreateUserInput): Promise<User> {
    assertRole(actor, ...ADMIN_ROLES);
    const scope = identityScopeOf(actor);
    const org = await this.orgs.findById(tx, scope, input.orgId);
    if (!org) throw IdentityErrors.organizationNotFound();
    if (!roleAllowedFor(org.type, input.role)) throw IdentityErrors.roleNotAllowedForOrg();
    assertPasswordPolicy(input.password);

    const id = await this.users.create(tx, {
      email: input.email,
      passwordHash: await this.hasher.hash(input.password),
      fullName: input.fullName,
    });
    await this.users.addMembership(tx, { userId: id, orgId: org.id, orgType: org.type, role: input.role });
    return (await this.users.findById(tx, scope, id))!.user;
  }
}

@Injectable()
export class ListUsersUseCase {
  constructor(private readonly users: UserRepository) {}

  async execute(db: Tx, actor: Actor, filter: UserFilter, paging: Paging): Promise<User[]> {
    assertRole(actor, ...ADMIN_ROLES);
    return this.users.list(db, identityScopeOf(actor), filter, paging);
  }
}

@Injectable()
export class GetUserUseCase {
  constructor(private readonly users: UserRepository) {}

  async execute(db: Tx, actor: Actor, id: string): Promise<User> {
    assertRole(actor, ...ADMIN_ROLES);
    const found = await this.users.findById(db, identityScopeOf(actor), id);
    if (!found) throw IdentityErrors.userNotFound();
    return found.user;
  }
}

export interface UpdateUserInput {
  fullName: string;
  role: Role;
  password?: string;
  isActive?: boolean;
  orgId?: string;
}

@Injectable()
export class UpdateUserUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly tokens: RefreshTokenRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async execute(tx: Tx, actor: Actor, id: string, input: UpdateUserInput): Promise<User> {
    assertRole(actor, ...ADMIN_ROLES);
    const scope = identityScopeOf(actor);
    const found = await this.users.findById(tx, scope, id);
    if (!found) throw IdentityErrors.userNotFound();
    const { user, hasMembershipsOutsideScope } = found;

    // The role applies to one membership; pick it unambiguously.
    let membership = user.memberships[0]!;
    if (input.orgId) {
      const chosen = user.memberships.find((m) => m.orgId === input.orgId);
      if (!chosen) throw IdentityErrors.organizationNotFound();
      membership = chosen;
    } else if (user.memberships.length > 1) {
      throw IdentityErrors.orgIdRequired();
    }
    if (!roleAllowedFor(membership.orgType, input.role)) throw IdentityErrors.roleNotAllowedForOrg();

    // Password, activation and name belong to the account, which every organisation
    // the user belongs to relies on. Only an admin who can see all of them may change it.
    const changesAccount =
      input.password !== undefined || input.isActive !== undefined || input.fullName !== user.fullName;
    if (changesAccount && hasMembershipsOutsideScope) {
      throw forbidden('This account also belongs to another organisation; its account details cannot be changed here.');
    }

    let passwordHash: string | undefined;
    if (input.password !== undefined) {
      assertPasswordPolicy(input.password);
      passwordHash = await this.hasher.hash(input.password);
    }

    await this.users.updateAccount(tx, id, { fullName: input.fullName, passwordHash, isActive: input.isActive });
    if (input.role !== membership.role) {
      await this.users.updateMembershipRole(tx, id, membership.orgId, input.role);
    }
    // A new password or a deactivation ends every existing session.
    if (passwordHash !== undefined || input.isActive === false) {
      await this.tokens.revokeAllForUser(tx, id);
    }

    return (await this.users.findById(tx, scope, id))!.user;
  }
}
