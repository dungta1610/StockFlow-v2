import { z } from 'zod';
import { pagingQuerySchema } from './common';

// GET /ops/outbox — the outbox relay's queue, for an operator watching for stuck or
// dead events (docs/adr/0017).

export const outboxEventStatusSchema = z.enum(['pending', 'processed', 'dead']);
export type OutboxEventStatus = z.infer<typeof outboxEventStatusSchema>;

export const listOutboxEventsQuerySchema = pagingQuerySchema.extend({
  status: outboxEventStatusSchema.optional(),
});
export type ListOutboxEventsQuery = z.infer<typeof listOutboxEventsQuerySchema>;

export interface OutboxEventView {
  id: number;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  org_id: string;
  status: OutboxEventStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  occurred_at: string;
  processed_at: string | null;
}
