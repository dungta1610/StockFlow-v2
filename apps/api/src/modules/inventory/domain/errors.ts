import { DomainError, badRequest } from '../../../platform/errors/domain-error';

/** Inventory failures. Codes are part of the public API contract. */
export const InventoryErrors = {
  inventoryNotFound: () =>
    new DomainError('INVENTORY_NOT_FOUND', 'No stock record for this product and warehouse.', 404),
  /** The move would leave a negative level; nothing was changed. */
  notEnoughStock: () => new DomainError('NOT_ENOUGH_STOCK', 'Not enough stock for this movement.', 409),
  invalidAdjustment: () =>
    badRequest('INVALID_ADJUSTMENT', 'An adjustment moves a non-zero whole number of units.'),
  invalidQuantity: () => badRequest('INVALID_QUANTITY', 'Quantity must be a positive whole number.'),
};
