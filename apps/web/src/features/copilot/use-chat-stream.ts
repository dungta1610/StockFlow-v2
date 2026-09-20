import type { CopilotStreamEvent } from '@stockflow/contracts';
import { useCallback, useRef, useState } from 'react';
import { sendCopilotMessage } from './copilot-api';
import type { ToolCall } from './tool-call-badge';

/** A turn as the screen renders it. The assistant's grows while the answer streams. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCall[];
  error?: string;
}

export interface ChatStream {
  turns: ChatTurn[];
  streaming: boolean;
  send: (input: string) => Promise<void>;
  stop: () => void;
  /** Replaces the transcript, e.g. when a stored session is opened. */
  reset: (turns: ChatTurn[]) => void;
}

/**
 * Drives one conversation.
 *
 * The rule the whole screen depends on: a turn is only ever appended to, and tool
 * calls are matched by `call_id`. A model can run two tools at once and finish
 * them out of order, so anything that assumed "the last badge is the one that
 * just ended" would eventually show the wrong tool as failed.
 */
export function useChatStream(sessionId: string | null): ChatStream {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setStreaming(false);
  }, []);

  const send = useCallback(
    async (input: string) => {
      if (!sessionId || streaming) return;
      const controller = new AbortController();
      abort.current = controller;
      setStreaming(true);
      setTurns((prev) => [
        ...prev,
        { role: 'user', content: input, toolCalls: [] },
        { role: 'assistant', content: '', toolCalls: [] },
      ]);

      const patch = (fn: (turn: ChatTurn) => ChatTurn) =>
        setTurns((prev) => prev.map((turn, i) => (i === prev.length - 1 ? fn(turn) : turn)));

      try {
        await sendCopilotMessage(sessionId, input, (event) => patch((turn) => apply(turn, event)), controller.signal);
      } catch (err) {
        // An aborted stream is the stop button working, not a failure to report.
        if (!controller.signal.aborted) {
          patch((turn) => ({ ...turn, error: err instanceof Error ? err.message : 'The assistant stopped responding.' }));
        }
      } finally {
        if (abort.current === controller) abort.current = null;
        setStreaming(false);
      }
    },
    [sessionId, streaming],
  );

  const reset = useCallback((next: ChatTurn[]) => {
    abort.current?.abort();
    abort.current = null;
    setStreaming(false);
    setTurns(next);
  }, []);

  return { turns, streaming, send, stop, reset };
}

/** Folds one stream event into the assistant turn being built. */
export function apply(turn: ChatTurn, event: CopilotStreamEvent): ChatTurn {
  switch (event.type) {
    case 'text':
      return { ...turn, content: turn.content + event.delta };
    case 'tool_start':
      return { ...turn, toolCalls: [...turn.toolCalls, { callId: event.call_id, name: event.name }] };
    case 'tool_end':
      return {
        ...turn,
        // Matched by id, not by position: tools can finish out of order.
        toolCalls: turn.toolCalls.map((call) =>
          call.callId === event.call_id ? { ...call, ok: event.ok, durationMs: event.duration_ms } : call,
        ),
      };
    case 'error':
      return { ...turn, error: event.message };
  }
}
