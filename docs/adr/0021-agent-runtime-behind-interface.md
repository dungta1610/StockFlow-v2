# 0021 — The agent loop is ours, behind an interface

**Status:** accepted · 2026-09-20

## Context
The ops console has to show which tool an answer came from and how long it took. That is
not decoration: a copilot that reaches real inventory and pricing data is only trustworthy
if an operator can see what it actually did.

The harness this was ported from could not provide it. Its `streamAgent` is an
`AsyncGenerator<string>` that yields `delta.type === 'textDelta'` and nothing else; the
comment beside it calls the SDK's event union "opaque here". No wrapper adds information a
stream never carried.

Whether `@strands-agents/sdk` surfaces tool lifecycle events on `agent.stream()` was to be
settled by a spike. The spike could not run — this environment has no AWS credentials (ADR
0003).

## Decision
Build the loop, behind an interface.

- **`AgentRuntime`** is the seam: `stream(RunInput)` and `run(RunInput)`, speaking
  `RunEvent` and `ToolDefinition` — types the harness owns, not an SDK's.
- **`OpenAiToolLoopRuntime`** is the implementation. It drives the OpenAI tool-calling
  protocol that LiteLLM serves for every provider behind it: assemble streamed tool-call
  deltas by index, validate arguments against the tool's zod schema, call the handler,
  append the result as a `tool` message, repeat.
- **It emits `tool_start` / `tool_end` itself**, around handlers it calls. That is the whole
  point: the events are facts it observes, not events it hopes to receive. `durationMs` is
  measured the same way, and is never reported as 0 — a handler that returns immediately
  still ran.
- **A failing tool is reported to the model, not thrown.** A handler that throws, and a
  model that sends arguments the schema rejects, both come back as `ok: false` on
  `tool_end` and as a `tool` message the model can react to. A turn is not failed by a tool
  that did not work.
- **Bounded at 6 model round trips.** Each tool result goes back to the model, which may
  call another tool; without a ceiling a model that keeps asking for the same tool burns
  budget until something else times out.

## Alternatives considered
- **Wait for credentials, then use Strands if the spike is favourable.** Rejected: it
  blocks 18 of the plan's 39 days on an external dependency, to buy at best ~0.5 day of
  mapping work.
- **Use Strands and map whatever events appear.** Rejected: the requirement is a guarantee,
  and a guarantee resting on unverified SDK behaviour is not one. If the events turn out
  not to exist, the discovery comes late and costs the same work anyway.

## Consequences
- The tool-event requirement no longer depends on any SDK's behaviour, and the harness has
  no model-SDK dependency at all — only `fetch` against an OpenAI-compatible endpoint.
- Adding a `StrandsAgentRuntime` later is one provider binding, proven by
  `test/harness/runtime-swappable.spec.ts`, which runs a whole turn on a runtime that never
  talks to a model.
- The message protocol is ours to maintain: assistant turns must be replayed verbatim with
  their `tool_calls`, or the `tool` messages that follow reference ids in no preceding
  message. That is written down here because it is the one part a refactor could break
  without any test noticing until a multi-tool turn is tried.
- Provider quirks (a model that streams tool arguments oddly) land in
  `LiteLlmGateway.streamChat`, not in the loop.
