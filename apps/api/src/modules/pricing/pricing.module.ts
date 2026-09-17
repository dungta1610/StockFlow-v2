import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { IdentityModule } from '../identity/identity.module';
import { PriceListRepository } from './application/ports/price-list.repository';
import { PriceResolver } from './application/ports/price-resolver';
import {
  ArchivePriceListUseCase,
  CreatePriceListUseCase,
  GetPriceListUseCase,
  ListPriceListsUseCase,
  UpsertPriceListItemsUseCase,
} from './application/use-cases/price-list.use-cases';
import { QuotePricesUseCase } from './application/use-cases/quote-prices.use-case';
import { PriceListController } from './http/price-list.controller';
import { QuoteController } from './http/quote.controller';
import { SqlPriceListRepository } from './infrastructure/sql-price-list.repository';
import { SqlPriceResolver } from './infrastructure/sql-price-resolver';

@Module({
  imports: [IdentityModule, CatalogModule],
  controllers: [PriceListController, QuoteController],
  providers: [
    { provide: PriceListRepository, useClass: SqlPriceListRepository },
    { provide: PriceResolver, useClass: SqlPriceResolver },
    CreatePriceListUseCase,
    UpsertPriceListItemsUseCase,
    ArchivePriceListUseCase,
    ListPriceListsUseCase,
    GetPriceListUseCase,
    QuotePricesUseCase,
  ],
  // Carts and orders price through the same resolver as quotes.
  exports: [PriceResolver],
})
export class PricingModule {}
