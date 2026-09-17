import { DomainError, badRequest, notFound } from '../../../platform/errors/domain-error';

/** Pricing failures. Codes are part of the public API contract. */
export const PricingErrors = {
  priceListNotFound: () => notFound('Price list'),
  priceListArchived: () =>
    new DomainError('PRICE_LIST_ARCHIVED', 'An archived price list cannot be changed.', 409),
  duplicateTier: () =>
    badRequest('DUPLICATE_TIER', 'Each (product, min_qty) tier may appear only once.'),
  invalidQuantity: () => badRequest('INVALID_QUANTITY', 'Quantity must be a positive whole number.'),
  customerOrgRequired: () =>
    badRequest('CUSTOMER_ORG_REQUIRED', 'customer_org_id is required when quoting on behalf of a customer.'),
  customerMustBeBuyer: () =>
    badRequest('CUSTOMER_NOT_BUYER', 'Contract prices exist only for buyer organisations.'),
  invalidValidity: () => badRequest('INVALID_VALIDITY', 'valid_to must be later than valid_from.'),
};
