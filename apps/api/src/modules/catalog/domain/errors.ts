import { DomainError } from '../../../platform/errors/domain-error';

/** Catalog failures. Codes are part of the public API contract. */
export const CatalogErrors = {
  productNotFound: () => new DomainError('PRODUCT_NOT_FOUND', 'Product not found.', 404),
  productInactive: (sku: string) =>
    new DomainError('PRODUCT_INACTIVE', `Product ${sku} is not available.`, 400, { sku }),
  skuAlreadyExists: () => new DomainError('SKU_ALREADY_EXISTS', 'Product SKU already exists.', 409),
  warehouseNotFound: () => new DomainError('WAREHOUSE_NOT_FOUND', 'Warehouse not found.', 404),
  warehouseCodeAlreadyExists: () =>
    new DomainError('WAREHOUSE_CODE_ALREADY_EXISTS', 'Warehouse code already exists.', 409),
};
