import { z } from 'zod';
import { pagingQuerySchema, uuidSchema } from './common';

// GET /ops/audit — a filtered projection of the outbox (docs/adr/0019). `summary` is
// a per-event-type whitelist built by the consumer, never the raw outbox payload.

export const listAuditLogQuerySchema = pagingQuerySchema.extend({
  aggregate_type: z.string().trim().min(1).max(50).optional(),
  aggregate_id: uuidSchema.optional(),
  event_type: z.string().trim().min(1).max(100).optional(),
});
export type ListAuditLogQuery = z.infer<typeof listAuditLogQuerySchema>;

export interface AuditLogView {
  id: number;
  event_id: number;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  org_id: string;
  actor_user_id: string | null;
  summary: Record<string, unknown>;
  occurred_at: string;
  recorded_at: string;
}
