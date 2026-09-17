import type { Tx } from '../../../../platform/database/tx';
import type { OrgScope } from '../../domain/org-scope';
import type { Organization } from '../../domain/organization';
import type { OrgType } from '../../domain/role';
import type { Paging } from './user.repository';

export interface OrganizationFilter {
  code?: string;
  type?: OrgType;
}

export abstract class OrganizationRepository {
  /** Throws ORG_CODE_ALREADY_EXISTS on a duplicate code. */
  abstract create(
    tx: Tx,
    data: { code: string; name: string; type: OrgType; taxCode: string | null },
  ): Promise<Organization>;

  /** Null when the organisation does not exist or is outside `scope`. */
  abstract findById(tx: Tx, scope: OrgScope, id: string): Promise<Organization | null>;

  abstract list(
    tx: Tx,
    scope: OrgScope,
    filter: OrganizationFilter,
    paging: Paging,
  ): Promise<Organization[]>;
}
