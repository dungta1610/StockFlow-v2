import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../../platform/database/tx';
import { OrganizationRepository } from '../../../identity/application/ports/organization.repository';
import { type Actor, assertRole, isInternalOps } from '../../../identity/domain/actor';
import { IdentityErrors } from '../../../identity/domain/errors';
import { orgScopeOf } from '../../../identity/domain/org-scope';
import { PricingErrors } from '../../domain/errors';
import { Money } from '../../domain/money';
import { type PriceLine, type PricedLine, PriceResolver } from '../ports/price-resolver';

export interface Quote {
  customerOrgId: string;
  pricedAt: Date;
  lines: PricedLine[];
  total: Money;
}

/**
 * Prices a cart without saving anything. Buyers always get their own
 * organisation's prices; ops name the customer they are quoting for.
 */
@Injectable()
export class QuotePricesUseCase {
  constructor(
    private readonly resolver: PriceResolver,
    private readonly organizations: OrganizationRepository,
  ) {}

  async execute(
    db: Tx,
    actor: Actor,
    input: { customerOrgId?: string; lines: readonly PriceLine[] },
    at: Date,
  ): Promise<Quote> {
    assertRole(actor, 'buyer', 'buyer_admin', 'ops', 'ops_admin');
    let customerOrgId = input.customerOrgId;
    if (customerOrgId === undefined) {
      if (isInternalOps(actor)) throw PricingErrors.customerOrgRequired();
      customerOrgId = actor.orgId;
    }

    const scope = orgScopeOf(actor);
    const customer = await this.organizations.findById(db, scope, customerOrgId);
    if (!customer) throw IdentityErrors.organizationNotFound();

    const lines = await this.resolver.resolve(db, scope, customer, input.lines, at);
    const total = lines.reduce((sum, l) => sum.plus(l.lineTotal), Money.ZERO);
    return { customerOrgId: customer.id, pricedAt: at, lines, total };
  }
}
