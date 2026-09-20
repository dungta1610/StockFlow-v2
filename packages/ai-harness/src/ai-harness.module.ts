import {
  Module,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { ChatTurnService } from './chat/chat-turn.service';
import {
  AGENT_RUNTIME,
  HARNESS_CONFIG,
  LLM_GATEWAY,
  MEMORY_STORE,
  validateHarnessConfig,
  type HarnessConfig,
} from './config/harness-config';
import { LiteLlmGateway } from './llm/litellm.gateway';
import { ConsolidationService } from './memory/consolidation.service';
import { EmbeddingService } from './memory/embedding.service';
import { PgVectorMemoryStore } from './memory/pgvector-memory.store';
import { RetrievalService } from './memory/retrieval.service';
import { OpenAiToolLoopRuntime } from './runtime/openai-tool-loop.runtime';
import { SessionService } from './session/session.service';
import { SessionSummaryService } from './session/session-summary.service';
import { ToolRegistry } from './tools/tool.registry';

/**
 * Configuration that has to be built from things only the host can supply — a
 * pool, a config service — which do not exist yet when a module list is evaluated.
 */
export interface AiHarnessAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: FactoryProvider['inject'];
  useFactory: (...args: never[]) => HarnessConfig | Promise<HarnessConfig>;
  /** Replaces the default pgvector store; a provider, so it can inject. */
  memoryStore?: Provider;
}

/**
 * The harness as an application consumes it.
 *
 * Everything host-specific arrives through `forRoot` — the pool, the gateway
 * endpoint, the agents, the strategies, the chat cadence — and is validated there
 * rather than trusted. The package reads no environment variable and ships no
 * controller: HTTP belongs to the application, because a route needs the
 * application's guards.
 */
@Module({})
export class AiHarnessModule {
  static forRoot(config: HarnessConfig): DynamicModule {
    return AiHarnessModule.build(
      { provide: HARNESS_CONFIG, useValue: validateHarnessConfig(config) },
      [],
      config.memoryStore,
    );
  }

  /** `forRoot` for a configuration that has to be built from injected providers. */
  static forRootAsync(options: AiHarnessAsyncOptions): DynamicModule {
    return AiHarnessModule.build(
      {
        provide: HARNESS_CONFIG,
        inject: options.inject ?? [],
        useFactory: async (...args: never[]) => validateHarnessConfig(await options.useFactory(...args)),
      },
      options.imports ?? [],
      options.memoryStore,
    );
  }

  private static build(
    configProvider: Provider,
    imports: ModuleMetadata['imports'],
    memoryStore: Provider | undefined,
  ): DynamicModule {
    const providers: Provider[] = [
      configProvider,
      { provide: LLM_GATEWAY, useClass: LiteLlmGateway },
      { provide: AGENT_RUNTIME, useClass: OpenAiToolLoopRuntime },
      memoryStore ?? { provide: MEMORY_STORE, useClass: PgVectorMemoryStore },
      EmbeddingService,
      RetrievalService,
      ConsolidationService,
      SessionService,
      SessionSummaryService,
      ToolRegistry,
      ChatTurnService,
    ];

    return {
      module: AiHarnessModule,
      // Global for the same reason the database module is: it is infrastructure
      // configured once at the composition root, and every feature module that uses
      // an agent would otherwise have to re-import it. Configuration still arrives
      // entirely through this call — the package reads no environment variable.
      global: true,
      imports,
      providers,
      exports: [
        HARNESS_CONFIG,
        LLM_GATEWAY,
        AGENT_RUNTIME,
        MEMORY_STORE,
        EmbeddingService,
        RetrievalService,
        ConsolidationService,
        SessionService,
        SessionSummaryService,
        ToolRegistry,
        ChatTurnService,
      ],
    };
  }
}
