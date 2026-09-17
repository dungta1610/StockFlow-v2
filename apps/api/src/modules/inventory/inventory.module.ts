import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryService } from './application/inventory.service';
import { LedgerService } from './application/ledger.service';
import { InventoryRepository } from './application/ports/inventory.repository';
import { LedgerRepository } from './application/ports/ledger.repository';
import { StockMovementService } from './application/stock-movement.service';
import { AdjustStockUseCase } from './application/use-cases/adjust-stock.use-case';
import {
  GetInventoryUseCase,
  ListInventoryTransactionsUseCase,
  ListInventoryUseCase,
} from './application/use-cases/read-inventory.use-cases';
import { InventoryController } from './http/inventory.controller';
import { SqlInventoryRepository } from './infrastructure/sql-inventory.repository';
import { SqlLedgerRepository } from './infrastructure/sql-ledger.repository';

@Module({
  imports: [CatalogModule],
  controllers: [InventoryController],
  providers: [
    { provide: InventoryRepository, useClass: SqlInventoryRepository },
    { provide: LedgerRepository, useClass: SqlLedgerRepository },
    AdjustStockUseCase,
    GetInventoryUseCase,
    ListInventoryUseCase,
    ListInventoryTransactionsUseCase,
    InventoryService,
    LedgerService,
    StockMovementService,
  ],
  // The repositories stay inside the module: stock moves only through
  // StockMovementService, which always writes the ledger row with the movement.
  exports: [StockMovementService, InventoryService, LedgerService],
})
export class InventoryModule {}
