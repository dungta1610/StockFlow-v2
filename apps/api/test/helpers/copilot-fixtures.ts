import type { INestApplication } from '@nestjs/common';
import { LLM_GATEWAY, ToolRegistry, type RunContext, type ToolDefinition } from '@stockflow/ai-harness';
import type { Actor } from '../../src/modules/identity/domain/actor';
import { toRunContext } from '../../src/modules/copilot/application/copilot-context';
import { FakeLlmGateway } from './harness-fixtures';
import { insertProduct, insertWarehouse } from './catalog-fixtures';
import { seedTenants, withDb, type Tenants } from './identity-fixtures';
import { createTestApp } from './test-app';

export interface CopilotApp {
  app: INestApplication;
  llm: FakeLlmGateway;
}

/**
 * The real application with one provider replaced: the LLM gateway.
 *
 * Nothing else is faked. The copilot's guards, scopes, transactions and SQL are
 * the ones that ship — which is the only way these tests can say anything about
 * whether adding an agent widened the attack surface.
 */
export async function createCopilotApp(): Promise<CopilotApp> {
  const llm = new FakeLlmGateway();
  const app = await createTestApp({
    override: (builder) => builder.overrideProvider(LLM_GATEWAY).useValue(llm),
  });
  return { app, llm };
}

export interface CopilotWorld extends Tenants {
  productId: string;
  sku: string;
  warehouseId: string;
  warehouseCode: string;
}

/** Tenants plus one product in one warehouse — enough for every tool to have an answer. */
export async function seedCopilotWorld(): Promise<CopilotWorld> {
  const tenants = await seedTenants();
  const { productId, warehouseId } = await withDb(async (pg) => ({
    productId: await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000', name: 'Widget' }),
    warehouseId: await insertWarehouse(pg, { code: 'HN-01' }),
  }));
  return { ...tenants, productId, sku: 'SKU-1', warehouseId, warehouseCode: 'HN-01' };
}

/** A run context for an actor, as the copilot builds one for a turn. */
export const contextFor = (actor: Actor, sessionId = '00000000-0000-0000-0000-0000000000aa'): RunContext =>
  toRunContext(actor, sessionId);

/** One tool, built for a caller exactly as a turn would build it. */
export function toolFor(app: INestApplication, name: string, actor: Actor, sessionId?: string): ToolDefinition {
  return app.get(ToolRegistry).build([name], contextFor(actor, sessionId))[0]!;
}

/** Creates a copilot session row for an actor, bypassing HTTP. */
export async function seedCopilotSession(actor: Actor, agentName = 'ops-copilot'): Promise<string> {
  return withDb(async (pg) => {
    const { rows } = await pg.query<{ id: string }>(
      `INSERT INTO ai.chat_sessions (agent_name, tenant_id, owner_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [agentName, actor.orgId, actor.userId],
    );
    return rows[0]!.id;
  });
}
