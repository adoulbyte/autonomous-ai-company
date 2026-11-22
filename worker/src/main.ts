import { loadConfig } from './config.js';
import { connect } from './db.js';
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
} catch (e) {
  console.error('worker crashed:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
