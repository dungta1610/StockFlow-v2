import { Module } from '@nestjs/common';
import { CatalogService } from './application/catalog.service';
import { ProductRepository, WarehouseRepository } from './application/ports/catalog.repositories';
import {
  CreateProductUseCase,
  GetProductUseCase,
  ListProductsUseCase,
  UpdateProductUseCase,
} from './application/use-cases/product.use-cases';
import {
  CreateWarehouseUseCase,
  GetWarehouseUseCase,
  ListWarehousesUseCase,
  UpdateWarehouseUseCase,
} from './application/use-cases/warehouse.use-cases';
import { ProductController } from './http/product.controller';
import { WarehouseController } from './http/warehouse.controller';
import { SqlProductRepository } from './infrastructure/sql-product.repository';
import { SqlWarehouseRepository } from './infrastructure/sql-warehouse.repository';

@Module({
  controllers: [ProductController, WarehouseController],
  providers: [
    { provide: ProductRepository, useClass: SqlProductRepository },
    { provide: WarehouseRepository, useClass: SqlWarehouseRepository },
    CatalogService,
    CreateProductUseCase,
    GetProductUseCase,
    ListProductsUseCase,
    UpdateProductUseCase,
    CreateWarehouseUseCase,
    GetWarehouseUseCase,
    ListWarehousesUseCase,
    UpdateWarehouseUseCase,
  ],
  // Other modules read the catalog only through CatalogService.
  exports: [CatalogService],
})
export class CatalogModule {}
