import type { OrgType } from './role';

export interface Organization {
  id: string;
  code: string;
  name: string;
  type: OrgType;
  taxCode: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Codes are stored upper-case and trimmed, like StockFlow's SKU and warehouse codes. */
export const normalizeOrgCode = (code: string): string => code.trim().toUpperCase();
