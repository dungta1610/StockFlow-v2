import { Inject, Injectable } from '@nestjs/common';
import { HARNESS_CONFIG, type ResolvedHarnessConfig } from '../config/harness-config';
import type { RunContext, ToolDefinition, ToolFactory } from '../config/types';

/**
 * Builds an agent's tools for one request.
 *
 * The registry holds *factories*, not instances. A tool that reaches real data has
 * to run as the caller, so an instance built once at boot would either have no
 * caller at all or — worse — keep the first one and hand their scope to everybody
 * who came after. Building per request makes that impossible to express.
 *
 * Extensibility contract: a new tool is one more factory, either in
 * `forRoot({ tools })` or registered by the module that owns it. Nothing here
 * changes. Registration exists because a tool that calls application services
 * needs those services injected, and `forRoot` runs before any of them exist — the
 * same reason outbox handlers register themselves with the relay.
 */
@Injectable()
export class ToolRegistry {
  private readonly factories: Map<string, ToolFactory>;

  constructor(@Inject(HARNESS_CONFIG) config: ResolvedHarnessConfig) {
    this.factories = new Map(config.tools.map((factory) => [factory.toolName, factory]));
  }

  /** Add a tool after boot. Throws on a name that is already taken. */
  register(factory: ToolFactory): void {
    if (this.factories.has(factory.toolName)) {
      throw new Error(`Tool "${factory.toolName}" is already registered.`);
    }
    this.factories.set(factory.toolName, factory);
  }

  /** Every registered tool name, for diagnostics and for host-side validation. */
  names(): string[] {
    return [...this.factories.keys()];
  }

  /**
   * Fail now rather than mid-conversation. An agent naming a tool nobody
   * registered is a wiring mistake, and the only cheap moment to notice it is boot.
   */
  assertKnown(names: readonly string[]): void {
    const missing = names.filter((name) => !this.factories.has(name));
    if (missing.length > 0) {
      throw new Error(`Unknown tool(s) ${missing.join(', ')}. Registered: ${this.names().join(', ')}`);
    }
  }

  /** Resolve names to tools bound to this request. Throws on an unknown name. */
  build(names: string[], ctx: RunContext): ToolDefinition[] {
    this.assertKnown(names);
    return names.map((name) => this.factories.get(name)!(ctx));
  }
}
