import type {
  CopilotMessageView,
  CopilotSessionView,
  CopilotStreamEvent,
  StockAdjustmentProposalView,
} from '@stockflow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { streamSse } from '@/lib/sse';

// POST/GET /copilot/** and /ops/stock-adjustment-proposals (docs/adr/0023, 0024).
// Ops only: callers gate on isOps before enabling any of this.

export function useCopilotSessions(enabled: boolean) {
  return useQuery({
    queryKey: ['copilot', 'sessions'],
    queryFn: () => api<{ data: CopilotSessionView[] }>('/copilot/sessions').then((r) => r.data),
    enabled,
  });
}

export function useCopilotSession(sessionId: string | null) {
  return useQuery({
    queryKey: ['copilot', 'session', sessionId],
    queryFn: () =>
      api<{ data: { session: CopilotSessionView; messages: CopilotMessageView[] } }>(
        `/copilot/sessions/${sessionId!}`,
      ).then((r) => r.data),
    enabled: sessionId !== null,
  });
}

export function useCreateCopilotSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ data: CopilotSessionView }>('/copilot/sessions', { method: 'POST', body: {} }).then((r) => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['copilot', 'sessions'] }),
  });
}

/** One streamed turn. Resolves when the stream ends; events arrive through `onEvent`. */
export function sendCopilotMessage(
  sessionId: string,
  input: string,
  onEvent: (event: CopilotStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamSse<CopilotStreamEvent>({
    path: `/copilot/sessions/${sessionId}/messages`,
    body: { input },
    ...(signal && { signal }),
    onEvent,
  });
}

export function useProposals(enabled: boolean) {
  return useQuery({
    queryKey: ['copilot', 'proposals'],
    queryFn: () =>
      api<{ data: StockAdjustmentProposalView[] }>('/ops/stock-adjustment-proposals', {
        query: { limit: 50 },
      }).then((r) => r.data),
    enabled,
  });
}

/**
 * Approving moves stock, so everything that shows stock is stale afterwards —
 * including screens the operator may have open in another tab.
 */
export function useDecideProposal(decision: 'approve' | 'reject') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) =>
      api<{ data: StockAdjustmentProposalView }>(`/ops/stock-adjustment-proposals/${proposalId}/${decision}`, {
        method: 'POST',
        body: {},
      }).then((r) => r.data),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['copilot', 'proposals'] }),
        queryClient.invalidateQueries({ queryKey: ['inventory'] }),
      ]);
    },
  });
}
