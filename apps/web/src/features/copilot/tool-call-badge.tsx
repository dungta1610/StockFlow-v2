import { Check, Loader2, X } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';

/** A tool call as the chat screen tracks it, built from `tool_start` / `tool_end`. */
export interface ToolCall {
  callId: string;
  name: string;
  /** Undefined while the call is still running. */
  ok?: boolean;
  durationMs?: number;
}

/** `get_inventory_status` → `get inventory status`. */
export const readableToolName = (name: string): string => name.replace(/_/g, ' ');

/**
 * What the assistant looked up, while it looks it up.
 *
 * This is the detail that makes the copilot answerable rather than merely
 * fluent: an operator about to act on a number can see it came from
 * `get_inventory_status` three hundred milliseconds ago, not from the model's
 * imagination. A failed call shows as failed for the same reason — an answer
 * built on a tool that errored is worth less, and hiding that would be the one
 * thing worse than not showing tools at all.
 */
export function ToolCallBadge({ call }: { call: ToolCall }) {
  const running = call.ok === undefined;
  const tone = running ? 'neutral' : call.ok ? 'green' : 'red';

  return (
    <Badge tone={tone} className="gap-1 font-mono text-[11px]">
      {running ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : call.ok ? (
        <Check className="size-3" aria-hidden />
      ) : (
        <X className="size-3" aria-hidden />
      )}
      <span>{readableToolName(call.name)}</span>
      {call.durationMs !== undefined && <span className="opacity-70">{call.durationMs}ms</span>}
      <span className="sr-only">
        {running ? 'running' : call.ok ? 'finished successfully' : 'failed'}
      </span>
    </Badge>
  );
}
