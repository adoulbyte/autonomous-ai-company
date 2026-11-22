import type { Sql, Tx } from '../db.js';
import type { AiGateway } from '../ai/gateway.js';
import type { TaskRow } from '../queue.js';
import { complete } from '../queue.js';
import type { MailTransport } from '../email/transport.js';

export class LeaseLostError extends Error { constructor() { super('lease lost before completion; result discarded'); } }

export interface HandlerContext {
  sql: Sql;
  ai: AiGateway;
  task: TaskRow;
  workerId: string;
  env: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  mail?: MailTransport | null;
  heartbeat: (progress?: number, note?: string) => Promise<void>;
}

export type Handler = (ctx: HandlerContext) => Promise<unknown>;

/**
 * Apply the handler's database writes AND mark the task succeeded in ONE transaction.
 * If the lease was lost (another worker took over), everything rolls back: no duplicate effects.
 */
export async function finish<T>(ctx: HandlerContext, writes: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.sql.begin(async (tx) => {
    const actor = `agent:${ctx.task.role_key ?? 'orchestrator'}`;
    await tx`select set_config('app.actor', ${actor}, true)`;
    const output = await writes(tx);
    const ok = await complete(tx, ctx.task.id, ctx.workerId, output ?? {});
    if (!ok) throw new LeaseLostError();
    return output;
  }) as Promise<T>;
}
