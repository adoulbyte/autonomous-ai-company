import { loadConfig } from './config.js';
import { appendFileSync } from 'node:fs';
import { connect, getSetting } from './db.js';
import { runWorker } from './runtime.js';

const cfg = loadConfig();
const sql = connect(cfg.databaseUrl);
let stopping = false;
process.on('SIGTERM', () => { stopping = true; console.log('SIGTERM received: leases will expire and tasks will be recovered by the next run'); });

try {
  const r = await runWorker({
    sql, workerId: cfg.workerId, runUrl: cfg.runUrl,
    timeBudgetMs: cfg.timeBudgetSeconds ? cfg.timeBudgetSeconds * 1000 : undefined,
    log: (m) => console.log(new Date().toISOString(), m),
  });
  console.log(`worker finished: ${r.succeeded} succeeded, ${r.failed} failed/deferred${stopping ? ' (stopping)' : ''}`);
  // Chain another run right away when work is waiting (bounded per 24h to stay inside free CI minutes).
  const sched = await getSetting<{ max_runs_per_day?: number; chain_when_backlog?: boolean }>(sql, 'worker.schedule', {});
  const [{ backlog }] = await sql`select count(*)::int as backlog from public.tasks where status in ('pending','retry_wait') and run_after <= now() + interval '5 minutes'
      and type not in ('comms.send','comms.poll_inbox','analytics.snapshot','system.health_check','strategy.review')`;
  const [{ runs }] = await sql`select count(*)::int as runs from public.worker_heartbeats where last_seen_at > now() - interval '24 hours'`;
  const killed = (await getSetting<boolean>(sql, 'system.kill_switch', false)) === true;
  const chain = !killed && !stopping && sched.chain_when_backlog !== false && backlog > 0 && runs < (sched.max_runs_per_day ?? 6);
  console.log(`backlog: ${backlog} task(s); runs in last 24h: ${runs}/${sched.max_runs_per_day ?? 6}; chain next run: ${chain}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `chain=${chain}\n`);
} catch (e) {
  console.error('worker crashed:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
