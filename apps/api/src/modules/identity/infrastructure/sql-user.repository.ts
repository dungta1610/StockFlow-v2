import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../platform/database/tx';
import {
  type Paging,
  type ScopedUser,
  type UserCredentials,
  type UserFilter,
  UserRepository,
} from '../application/ports/user.repository';
import { IdentityErrors } from '../domain/errors';
import type { OrgScope } from '../domain/org-scope';
import type { OrgType, Role } from '../domain/role';
import type { Membership, User } from '../domain/user';
import { escapeLike, isUniqueViolation, pagingSql, paramBinder } from '../../../platform/database/sql';
import { scopeSql } from './scope-sql';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  memberships: Membership[] | null;
}

const USER_COLUMNS = 'u.id, u.email, u.full_name, u.is_active, u.created_at, u.updated_at';

const MEMBERSHIP_JSON = `json_build_object(
  'orgId', o.id, 'orgCode', o.code, 'orgType', o.type,
  'orgIsActive', o.is_active, 'role', m.role)`;

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  fullName: r.full_name,
  isActive: r.is_active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  memberships: r.memberships ?? [],
});

@Injectable()
export class SqlUserRepository extends UserRepository {
  async findCredentialsByEmail(tx: Tx, email: string): Promise<UserCredentials | null> {
    const [row] = await tx.query<UserRow & { password_hash: string }>(
      `SELECT ${USER_COLUMNS}, u.password_hash,
              json_agg(${MEMBERSHIP_JSON} ORDER BY o.code) FILTER (WHERE o.id IS NOT NULL) AS memberships
         FROM users u
         LEFT JOIN org_members m ON m.user_id = u.id
         LEFT JOIN organizations o ON o.id = m.org_id
        WHERE u.email = $1
        GROUP BY u.id`,
      [email],
    );
    return row ? { user: toUser(row), passwordHash: row.password_hash } : null;
  }

  async findById(tx: Tx, scope: OrgScope, id: string): Promise<ScopedUser | null> {
    const params: unknown[] = [id];
    const inScope = scopeSql(scope, { id: 'o.id', type: 'o.type' }, params);
    const [row] = await tx.query<UserRow & { outside: boolean }>(
      `SELECT ${USER_COLUMNS},
              json_agg(${MEMBERSHIP_JSON} ORDER BY o.code) FILTER (WHERE ${inScope}) AS memberships,
              bool_or(NOT (${inScope})) AS outside
         FROM users u
         JOIN org_members m ON m.user_id = u.id
         JOIN organizations o ON o.id = m.org_id
        WHERE u.id = $1
        GROUP BY u.id`,
      params,
    );
    if (!row?.memberships?.length) return null;
    return { user: toUser(row), hasMembershipsOutsideScope: row.outside };
  }

  async list(tx: Tx, scope: OrgScope, filter: UserFilter, paging: Paging): Promise<User[]> {
    const params: unknown[] = [];
    const where = [scopeSql(scope, { id: 'o.id', type: 'o.type' }, params)];
    const bind = paramBinder(params);
    // Same filters as StockFlow's ListUsers: exact email, partial name, role, is_active.
    if (filter.email) where.push(`u.email = ${bind(filter.email)}`);
    if (filter.fullName) where.push(`u.full_name ILIKE ${bind(`%${escapeLike(filter.fullName)}%`)}`);
    if (filter.isActive !== undefined) where.push(`u.is_active = ${bind(filter.isActive)}`);

    // Membership filters choose which users match, but the result still lists every
    // membership in scope — otherwise an admin could not see that an account is shared.
    if (filter.role || filter.orgId) {
      const cond = [scopeSql(scope, { id: 'fo.id', type: 'fo.type' }, params)];
      if (filter.role) cond.push(`fm.role = ${bind(filter.role)}`);
      if (filter.orgId) cond.push(`fm.org_id = ${bind(filter.orgId)}`);
      where.push(`EXISTS (
        SELECT 1 FROM org_members fm JOIN organizations fo ON fo.id = fm.org_id
         WHERE fm.user_id = u.id AND ${cond.join(' AND ')})`);
    }

    const rows = await tx.query<UserRow>(
      `SELECT ${USER_COLUMNS},
              json_agg(${MEMBERSHIP_JSON} ORDER BY o.code) AS memberships
         FROM users u
         JOIN org_members m ON m.user_id = u.id
         JOIN organizations o ON o.id = m.org_id
        WHERE ${where.join(' AND ')}
        GROUP BY u.id
        ORDER BY u.created_at DESC, u.id DESC
        ${pagingSql(paging, params)}`,
      params,
    );
    return rows.map(toUser);
  }

  async findActiveMembership(
    tx: Tx,
    userId: string,
    orgId: string,
  ): Promise<{ user: User; membership: Membership } | null> {
    const [row] = await tx.query<UserRow & { acting: Membership | null }>(
      `SELECT ${USER_COLUMNS},
              json_agg(${MEMBERSHIP_JSON} ORDER BY o.code) AS memberships,
              (array_agg(${MEMBERSHIP_JSON}) FILTER (WHERE o.id = $2 AND o.is_active))[1] AS acting
         FROM users u
         JOIN org_members m ON m.user_id = u.id
         JOIN organizations o ON o.id = m.org_id
        WHERE u.id = $1 AND u.is_active
        GROUP BY u.id`,
      [userId, orgId],
    );
    if (!row?.acting) return null;
    return { user: toUser(row), membership: row.acting };
  }

  async create(
    tx: Tx,
    data: { email: string; passwordHash: string; fullName: string },
  ): Promise<string> {
    try {
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id`,
        [data.email, data.passwordHash, data.fullName],
      );
      return row!.id;
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_key')) throw IdentityErrors.emailAlreadyExists();
      throw err;
    }
  }

  async addMembership(
    tx: Tx,
    data: { userId: string; orgId: string; orgType: OrgType; role: Role },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO org_members (org_id, org_type, user_id, role) VALUES ($1, $2, $3, $4)`,
      [data.orgId, data.orgType, data.userId, data.role],
    );
  }

  async updateAccount(
    tx: Tx,
    id: string,
    data: { fullName: string; passwordHash?: string; isActive?: boolean },
  ): Promise<void> {
    // Mirrors StockFlow's UpdateUser: full_name always, the rest only when given.
    const params: unknown[] = [data.fullName];
    const sets = ['full_name = $1'];
    if (data.passwordHash !== undefined) {
      params.push(data.passwordHash);
      sets.push(`password_hash = $${params.length}`);
    }
    if (data.isActive !== undefined) {
      params.push(data.isActive);
      sets.push(`is_active = $${params.length}`);
    }
    params.push(id);
    await tx.query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
      params,
    );
  }

  async updateMembershipRole(tx: Tx, userId: string, orgId: string, role: Role): Promise<void> {
    await tx.query(`UPDATE org_members SET role = $1 WHERE user_id = $2 AND org_id = $3`, [
      role,
      userId,
      orgId,
    ]);
  }
}
