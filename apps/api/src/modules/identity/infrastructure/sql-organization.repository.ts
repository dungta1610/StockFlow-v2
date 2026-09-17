import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../platform/database/tx';
import {
  type OrganizationFilter,
  OrganizationRepository,
} from '../application/ports/organization.repository';
import type { Paging } from '../application/ports/user.repository';
import { IdentityErrors } from '../domain/errors';
import type { OrgScope } from '../domain/org-scope';
import type { Organization } from '../domain/organization';
import type { OrgType } from '../domain/role';
import { isUniqueViolation, pagingSql } from '../../../platform/database/sql';
import { scopeSql } from './scope-sql';

interface OrgRow {
  id: string;
  code: string;
  name: string;
  type: OrgType;
  tax_code: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, code, name, type, tax_code, is_active, created_at, updated_at';

const toOrg = (r: OrgRow): Organization => ({
  id: r.id,
  code: r.code,
  name: r.name,
  type: r.type,
  taxCode: r.tax_code,
  isActive: r.is_active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

@Injectable()
export class SqlOrganizationRepository extends OrganizationRepository {
  async create(
    tx: Tx,
    data: { code: string; name: string; type: OrgType; taxCode: string | null },
  ): Promise<Organization> {
    try {
      const [row] = await tx.query<OrgRow>(
        `INSERT INTO organizations (code, name, type, tax_code)
         VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
        [data.code, data.name, data.type, data.taxCode],
      );
      return toOrg(row!);
    } catch (err) {
      if (isUniqueViolation(err, 'organizations_code_key')) throw IdentityErrors.orgCodeAlreadyExists();
      throw err;
    }
  }

  async findById(tx: Tx, scope: OrgScope, id: string): Promise<Organization | null> {
    const params: unknown[] = [id];
    const inScope = scopeSql(scope, { id: 'id', type: 'type' }, params);
    const [row] = await tx.query<OrgRow>(
      `SELECT ${COLUMNS} FROM organizations WHERE id = $1 AND ${inScope}`,
      params,
    );
    return row ? toOrg(row) : null;
  }

  async list(
    tx: Tx,
    scope: OrgScope,
    filter: OrganizationFilter,
    paging: Paging,
  ): Promise<Organization[]> {
    const params: unknown[] = [];
    const where = [scopeSql(scope, { id: 'id', type: 'type' }, params)];
    if (filter.code) {
      params.push(filter.code);
      where.push(`code = $${params.length}`);
    }
    if (filter.type) {
      params.push(filter.type);
      where.push(`type = $${params.length}`);
    }
    const rows = await tx.query<OrgRow>(
      `SELECT ${COLUMNS} FROM organizations
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        ${pagingSql(paging, params)}`,
      params,
    );
    return rows.map(toOrg);
  }
}
