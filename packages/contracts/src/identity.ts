import { z } from 'zod';
import { pagingQuerySchema, queryBoolSchema, uuidSchema } from './common';

// JSON field names are snake_case, matching StockFlow's (Go) API.

export const orgTypeSchema = z.enum(['buyer', 'internal']);
export type OrgTypeValue = z.infer<typeof orgTypeSchema>;
export const roleSchema = z.enum(['buyer', 'buyer_admin', 'ops', 'ops_admin']);
export type RoleValue = z.infer<typeof roleSchema>;

const email = z.string().trim().toLowerCase().pipe(z.email());
const password = z.string().min(1);
const trimmed = (max: number) => z.string().trim().min(1).max(max);

// ── Auth ─────────────────────────────────────────────────────────────

export const loginRequestSchema = z.object({
  email,
  password,
  /** Required only when the account belongs to more than one organisation. */
  org_code: z.string().trim().toUpperCase().min(1).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export interface MembershipView {
  org_id: string;
  org_code: string;
  org_type: z.infer<typeof orgTypeSchema>;
  role: z.infer<typeof roleSchema>;
}

export interface UserView {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  memberships: MembershipView[];
  created_at: string;
  updated_at: string;
}

export interface SessionView {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: UserView;
  /** The organisation and role this session acts with. */
  acting_as: MembershipView;
}

// ── Organisations ────────────────────────────────────────────────────

export const createOrganizationRequestSchema = z.object({
  code: z.string().trim().toUpperCase().min(1).max(50),
  name: trimmed(200),
  type: orgTypeSchema,
  tax_code: z.string().trim().max(50).optional(),
});
export type CreateOrganizationRequest = z.infer<typeof createOrganizationRequestSchema>;

export const listOrganizationsQuerySchema = pagingQuerySchema.extend({
  code: z.string().trim().toUpperCase().optional(),
  type: orgTypeSchema.optional(),
});
export type ListOrganizationsQuery = z.infer<typeof listOrganizationsQuerySchema>;

export interface OrganizationView {
  id: string;
  code: string;
  name: string;
  type: z.infer<typeof orgTypeSchema>;
  tax_code: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// ── Users (StockFlow /users, now scoped to organisations) ────────────

export const createUserRequestSchema = z.object({
  email,
  /** Plain text; hashed by the server. (StockFlow accepted a client-side hash.) */
  password,
  full_name: trimmed(200),
  org_id: uuidSchema,
  role: roleSchema,
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

/** StockFlow's UserUpdate: full_name and role required, password and is_active optional. */
export const updateUserRequestSchema = z.object({
  full_name: trimmed(200),
  role: roleSchema,
  password: password.optional(),
  is_active: z.boolean().optional(),
  /** Which membership the role applies to, when the user has several in scope. */
  org_id: uuidSchema.optional(),
});
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

/** StockFlow's user Filter plus an organisation filter. */
export const listUsersQuerySchema = pagingQuerySchema.extend({
  email: z.string().trim().toLowerCase().optional(),
  full_name: z.string().trim().optional(),
  role: roleSchema.optional(),
  is_active: queryBoolSchema.optional(),
  org_id: uuidSchema.optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
