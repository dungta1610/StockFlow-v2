import { z } from 'zod';
import { pagingQuerySchema, uuidSchema } from './common';

// The ops copilot: chat sessions, and the stock adjustments it proposes for a
// person to approve (docs/adr/0023, 0024).

export const createCopilotSessionRequestSchema = z.object({
  /** Optional: there is one agent today, and it is the default. */
  agent_name: z.string().min(1).max(64).optional(),
});
export type CreateCopilotSessionRequest = z.infer<typeof createCopilotSessionRequestSchema>;

export const sendCopilotMessageRequestSchema = z.object({
  input: z.string().min(1).max(4_000),
});
export type SendCopilotMessageRequest = z.infer<typeof sendCopilotMessageRequestSchema>;

export interface CopilotSessionView {
  id: string;
  agent_name: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

export interface CopilotMessageView {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

/**
 * What a streamed turn sends, mirroring the harness's `RunEvent`. `tool_start` and
 * `tool_end` are part of the contract, not a debug extra: the console shows which
 * tool an answer came from and how long it took, and an answer nobody can trace to
 * a tool call is one nobody should act on.
 */
export type CopilotStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; call_id: string; name: string }
  | { type: 'tool_end'; call_id: string; name: string; ok: boolean; duration_ms: number }
  | { type: 'error'; message: string };

export const proposalStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const listProposalsQuerySchema = pagingQuerySchema.extend({
  status: proposalStatusSchema.optional(),
});
export type ListProposalsQuery = z.infer<typeof listProposalsQuerySchema>;

export const rejectProposalRequestSchema = z.object({
  note: z.string().max(500).optional(),
});
export type RejectProposalRequest = z.infer<typeof rejectProposalRequestSchema>;

export interface StockAdjustmentProposalView {
  id: string;
  sku: string;
  product_name: string;
  warehouse_code: string;
  delta_qty: number;
  reason: string;
  rationale: string | null;
  session_id: string | null;
  status: ProposalStatus;
  proposed_by_user_id: string;
  decided_by_user_id: string | null;
  decided_at: string | null;
  applied_transaction_id: string | null;
  created_at: string;
}

/** Path parameter shared by the approve and reject routes. */
export const proposalIdSchema = uuidSchema;
