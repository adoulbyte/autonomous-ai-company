import type { Sql, Tx } from './db.js';

export interface TaskRow {
  id: string; type: string; role_key: string | null; status: string; priority: number; title: string | null;
  entity_type: string | null; entity_id: string | null; input: Record<string, any>; attempts: number; max_attempts: number;
  timeout_seconds: number; lease_owner: string | null; deferrals: number;
}

export interface EnqueueArgs {
  type: string; key: string; input?: Record<string, unknown>; role?: string | null; entityType?: string | null; entityId?: string | null;
  priority?: number; runAfter?: Date; maxAttempts?: number; timeoutSeconds?: number; dependsOn?: string[]; title?: string;
  parentTaskId?: string | null; approvalId?: string | null;
}

export async function enqueue(sql: Sql | Tx, a: EnqueueArgs): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select public.enqueue_task(
      p_type => ${a.type}, p_idempotency_key => ${a.key}, p_input => ${sql.json((a.input ?? {}) as never)},
      p_role_key => ${a.role ?? null}, p_entity_type => ${a.entityType ?? null}, p_entity_id => ${a.entityId ?? null},
      p_priority => ${a.priority ?? 50}, p_run_after => ${a.runAfter ?? new Date()}, p_max_attempts => ${a.maxAttempts ?? 3},
      p_timeout_seconds => ${a.timeoutSeconds ?? 180}, p_depends_on => ${(a.dependsOn ?? []) as never}::uuid[], p_title => ${a.title ?? null},
      p_parent_task_id => ${a.parentTaskId ?? null}, p_approval_id => ${a.approvalId ?? null}) as id`;
  return row.id;
}

export async function claim(sql: Sql, workerId: string, limit = 1, types: string[] | null = null): Promise<TaskRow[]> {
  return sql<TaskRow[]>`select * from public.claim_tasks(${workerId}, ${limit}, ${types as never})`;
}

export async function complete(sql: Sql | Tx, taskId: string, workerId: string, output: unknown): Promise<boolean> {
  const [r] = await sql<{ ok: boolean }[]>`select public.complete_task(${taskId}, ${workerId}, ${sql.json((output ?? {}) as never)}) as ok`;
  return r.ok;
}

export async function fail(sql: Sql, taskId: string, workerId: string, error: string, retryable: boolean): Promise<string> {
  const [r] = await sql<{ s: string }[]>`select public.fail_task(${taskId}, ${workerId}, ${error}, ${retryable}) as s`;
  return r.s;
}

export async function defer(sql: Sql, taskId: string, workerId: string, seconds: number, reason: string): Promise<string> {
  const [r] = await sql<{ s: string }[]>`select public.defer_task(${taskId}, ${workerId}, ${seconds}, ${reason}) as s`;
  return r.s;
}

export async function heartbeat(sql: Sql, taskId: string, workerId: string, progress?: number, note?: string): Promise<boolean> {
  const [r] = await sql<{ ok: boolean }[]>`select public.heartbeat_task(${taskId}, ${workerId}, ${progress ?? null}, ${note ?? null}) as ok`;
  return r.ok;
}

export async function requestApproval(sql: Sql | Tx, a: {
  actionType: string; title: string; requestedBy: string; reason: string; ifApproved: string; ifRejected: string;
  payload?: Record<string, unknown>; evidence?: unknown[]; expectedBenefit?: string; risk?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'; costMinor?: number; currency?: string;
  entityType?: string; entityId?: string; taskId?: string; key: string;
}): Promise<string> {
  const [r] = await sql<{ id: string }[]>`select public.request_approval(
    p_action_type => ${a.actionType}, p_title => ${a.title}, p_requested_by => ${a.requestedBy}, p_reason => ${a.reason},
    p_if_approved => ${a.ifApproved}, p_if_rejected => ${a.ifRejected}, p_payload => ${sql.json((a.payload ?? {}) as never)},
    p_evidence => ${sql.json((a.evidence ?? []) as never)}, p_expected_benefit => ${a.expectedBenefit ?? null}, p_risk => ${a.risk ?? null},
    p_risk_level => ${a.riskLevel ?? 'medium'}, p_cost_minor => ${a.costMinor ?? 0}, p_currency => ${a.currency ?? 'USD'},
    p_entity_type => ${a.entityType ?? null}, p_entity_id => ${a.entityId ?? null}, p_task_id => ${a.taskId ?? null},
    p_idempotency_key => ${a.key}) as id`;
  return r.id;
}

/** Auto-approve if (and only if) autonomy.policy marks this action type "auto". Returns whether it was approved. */
export async function autoApproveIfPolicy(sql: Sql | Tx, approvalId: string): Promise<boolean> {
  const [r] = await sql<{ ok: boolean }[]>`select public.system_auto_approve(${approvalId}) as ok`;
  return r.ok;
}
