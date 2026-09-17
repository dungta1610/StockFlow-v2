import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../../platform/database/tx';
import { type Actor, assertRole } from '../../domain/actor';
import { IdentityErrors } from '../../domain/errors';
import { identityScopeOf } from '../../domain/org-scope';
import { type Organization, normalizeOrgCode } from '../../domain/organization';
import type { OrgType } from '../../domain/role';
import { type OrganizationFilter, OrganizationRepository } from '../ports/organization.repository';
import type { Paging } from '../ports/user.repository';

// Organisation use cases are one-liners over the repository; they share a file.

@Injectable()
export class CreateOrganizationUseCase {
  constructor(private readonly orgs: OrganizationRepository) {}

  async execute(
    tx: Tx,
    actor: Actor,
    input: { code: string; name: string; type: OrgType; taxCode?: string },
  ): Promise<Organization> {
    assertRole(actor, 'ops_admin');
    return this.orgs.create(tx, {
      code: normalizeOrgCode(input.code),
      name: input.name.trim(),
      type: input.type,
      taxCode: input.taxCode?.trim() || null,
    });
  }
}

@Injectable()
export class ListOrganizationsUseCase {
  constructor(private readonly orgs: OrganizationRepository) {}

  async execute(db: Tx, actor: Actor, filter: OrganizationFilter, paging: Paging): Promise<Organization[]> {
    return this.orgs.list(db, identityScopeOf(actor), filter, paging);
  }
}

@Injectable()
export class GetOrganizationUseCase {
  constructor(private readonly orgs: OrganizationRepository) {}

  async execute(db: Tx, actor: Actor, id: string): Promise<Organization> {
    const org = await this.orgs.findById(db, identityScopeOf(actor), id);
    if (!org) throw IdentityErrors.organizationNotFound();
    return org;
  }
}
