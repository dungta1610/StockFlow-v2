import { Injectable } from '@nestjs/common';
import type { Paging } from '../../../../platform/database/sql';
import type { Tx } from '../../../../platform/database/tx';
import { CatalogService } from '../../../catalog/application/catalog.service';
import { CatalogErrors } from '../../../catalog/domain/errors';
import { OrganizationRepository } from '../../../identity/application/ports/organization.repository';
import { type Actor, assertRole } from '../../../identity/domain/actor';
import { IdentityErrors } from '../../../identity/domain/errors';
import { identityScopeOf, orgScopeOf } from '../../../identity/domain/org-scope';
import { PricingErrors } from '../../domain/errors';
import { Money } from '../../domain/money';
import type { PriceList, PriceListFilter, PriceListItem } from '../../domain/price-list';
import { PriceListRepository } from '../ports/price-list.repository';

// Price lists are an ops concern: ops read them, only ops_admin changes them.
// Buyers see prices only through quotes.

export type PriceListWithItems = PriceList & { items: PriceListItem[] };

@Injectable()
export class CreatePriceListUseCase {
  constructor(
    private readonly priceLists: PriceListRepository,
    private readonly organizations: OrganizationRepository,
  ) {}

  async execute(
    tx: Tx,
    actor: Actor,
    input: { orgId: string | null; name: string; validFrom: Date; validTo: Date | null; priority: number },
  ): Promise<PriceList> {
    assertRole(actor, 'ops_admin');
    if (input.orgId !== null) {
      const org = await this.organizations.findById(tx, identityScopeOf(actor), input.orgId);
      if (!org) throw IdentityErrors.organizationNotFound();
      if (org.type !== 'buyer') throw PricingErrors.customerMustBeBuyer();
    }
    if (input.validTo !== null && input.validTo.getTime() <= input.validFrom.getTime()) {
      throw PricingErrors.invalidValidity();
    }
    return this.priceLists.create(tx, { ...input, name: input.name.trim() });
  }
}

@Injectable()
export class UpsertPriceListItemsUseCase {
  constructor(
    private readonly priceLists: PriceListRepository,
    private readonly catalog: CatalogService,
  ) {}

  async execute(
    tx: Tx,
    actor: Actor,
    priceListId: string,
    items: readonly { productId: string; minQty: number; unitPrice: string }[],
  ): Promise<PriceListWithItems> {
    assertRole(actor, 'ops_admin');
    const tiers = items.map((i) => ({
      productId: i.productId.toLowerCase(),
      minQty: i.minQty,
      unitPrice: Money.parse(i.unitPrice),
    }));
    if (tiers.some((t) => !Number.isSafeInteger(t.minQty) || t.minQty < 1)) throw PricingErrors.invalidQuantity();
    if (new Set(tiers.map((t) => `${t.productId}:${t.minQty}`)).size !== tiers.length) {
      throw PricingErrors.duplicateTier();
    }
    // Locked so an archive running at the same time cannot slip in between the
    // status check and the write.
    const list = await this.priceLists.findById(tx, orgScopeOf(actor), priceListId, { forUpdate: true });
    if (!list) throw PricingErrors.priceListNotFound();
    if (list.status === 'archived') throw PricingErrors.priceListArchived();

    const products = await this.catalog.findProducts(tx, [...new Set(tiers.map((t) => t.productId))]);
    if (tiers.some((t) => !products.has(t.productId))) throw CatalogErrors.productNotFound();

    await this.priceLists.upsertItems(tx, priceListId, tiers);
    const updated = await this.priceLists.findById(tx, orgScopeOf(actor), priceListId);
    return { ...updated!, items: await this.priceLists.findItems(tx, priceListId) };
  }
}

@Injectable()
export class ArchivePriceListUseCase {
  constructor(private readonly priceLists: PriceListRepository) {}

  async execute(tx: Tx, actor: Actor, priceListId: string): Promise<PriceListWithItems> {
    assertRole(actor, 'ops_admin');
    const list = await this.priceLists.archive(tx, orgScopeOf(actor), priceListId);
    if (!list) throw PricingErrors.priceListNotFound();
    return { ...list, items: await this.priceLists.findItems(tx, priceListId) };
  }
}

@Injectable()
export class ListPriceListsUseCase {
  constructor(private readonly priceLists: PriceListRepository) {}

  async execute(db: Tx, actor: Actor, filter: PriceListFilter, paging: Paging): Promise<PriceList[]> {
    assertRole(actor, 'ops', 'ops_admin');
    return this.priceLists.list(db, orgScopeOf(actor), filter, paging);
  }
}

@Injectable()
export class GetPriceListUseCase {
  constructor(private readonly priceLists: PriceListRepository) {}

  async execute(db: Tx, actor: Actor, priceListId: string): Promise<PriceListWithItems> {
    assertRole(actor, 'ops', 'ops_admin');
    const list = await this.priceLists.findById(db, orgScopeOf(actor), priceListId);
    if (!list) throw PricingErrors.priceListNotFound();
    return { ...list, items: await this.priceLists.findItems(db, priceListId) };
  }
}
