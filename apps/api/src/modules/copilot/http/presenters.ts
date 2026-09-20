import type {
  CopilotMessageView,
  CopilotSessionView,
  CopilotStreamEvent,
  StockAdjustmentProposalView,
} from '@stockflow/contracts';
import type { ChatSession, RunEvent, StoredMessage } from '@stockflow/ai-harness';
import type { StockAdjustmentProposal } from '../domain/stock-adjustment-proposal';

export const presentSession = (s: ChatSession, messageCount?: number): CopilotSessionView => ({
  id: s.id,
  agent_name: s.agentName,
  created_at: s.createdAt.toISOString(),
  updated_at: s.updatedAt.toISOString(),
  ...(messageCount !== undefined && { message_count: messageCount }),
});

export const presentMessage = (m: StoredMessage): CopilotMessageView => ({
  id: m.id,
  role: m.role,
  content: m.content,
  created_at: m.createdAt.toISOString(),
});

/**
 * The harness's event, on the wire.
 *
 * `tool_start` deliberately drops the tool's arguments. They can contain whatever
 * the model decided to look up, which is fine inside the process but is not
 * something to stream at a browser by default; the tool's name and timing are what
 * the console needs.
 */
export function presentEvent(event: RunEvent): CopilotStreamEvent {
  switch (event.type) {
    case 'text':
      return { type: 'text', delta: event.delta };
    case 'tool_start':
      return { type: 'tool_start', call_id: event.callId, name: event.name };
    case 'tool_end':
      return {
        type: 'tool_end',
        call_id: event.callId,
        name: event.name,
        ok: event.ok,
        duration_ms: event.durationMs,
      };
    case 'error':
      return { type: 'error', message: event.message };
  }
}

export const presentProposal = (p: StockAdjustmentProposal): StockAdjustmentProposalView => ({
  id: p.id,
  sku: p.sku,
  product_name: p.productName,
  warehouse_code: p.warehouseCode,
  delta_qty: p.deltaQty,
  reason: p.reason,
  rationale: p.rationale,
  session_id: p.sessionId,
  status: p.status,
  proposed_by_user_id: p.proposedByUserId,
  decided_by_user_id: p.decidedByUserId,
  decided_at: p.decidedAt ? p.decidedAt.toISOString() : null,
  applied_transaction_id: p.appliedTransactionId,
  created_at: p.createdAt.toISOString(),
});
