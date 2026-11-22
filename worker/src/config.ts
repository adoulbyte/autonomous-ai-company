export interface WorkerConfig {
  databaseUrl: string;
  workerId: string;
  runUrl?: string;
  timeBudgetSeconds?: number;
  githubToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required (Supabase connection string, session pooler).');
  const runId = env.GITHUB_RUN_ID ? `gha-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}` : `local-${process.pid}`;
  return {
    databaseUrl,
    workerId: env.WORKER_ID ?? runId,
    runUrl: env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
      ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined,
    timeBudgetSeconds: env.WORKER_TIME_BUDGET ? Number(env.WORKER_TIME_BUDGET) : undefined,
    githubToken: env.GITHUB_TOKEN,
  };
}
