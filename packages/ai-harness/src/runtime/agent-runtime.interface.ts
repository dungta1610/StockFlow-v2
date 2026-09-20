import type { RunEvent, RunInput, RunResult } from '../config/types';

/**
 * Runs one agent turn.
 *
 * Behind an interface because the guarantee the application depends on —
 * observable `tool_start`/`tool_end` around every call — is a property of the
 * runtime, not of any model SDK. Swapping the implementation is a DI binding, and
 * a test proves ChatTurnService still works when it is swapped.
 */
export interface AgentRuntime {
  stream(input: RunInput): AsyncIterable<RunEvent>;
  run(input: RunInput): Promise<RunResult>;
}
