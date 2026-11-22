import postgres from 'postgres';

export type Sql = postgres.Sql<Record<string, unknown>>;
export type Tx = postgres.TransactionSql<Record<string, unknown>>;

export function connect(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 4,
    prepare: false,              // compatible with Supabase poolers
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
    ssl: /localhost|127\.0\.0\.1|host=\/|@\/|\?host=/.test(url) ? false : 'require',
    connection: { application_name: 'aic-worker' },
  }) as Sql;
}

/** Run fn in a transaction with app.actor set (used by audit/event triggers). */
export async function withActor<T>(sql: Sql, actor: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.actor', ${actor}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

export async function getSetting<T>(sql: Sql | Tx, key: string, fallback: T): Promise<T> {
  const rows = await sql`select value from public.settings where key = ${key}`;
  return rows.length ? (rows[0].value as T) : fallback;
}

export async function logEvent(sql: Sql | Tx, entityType: string, entityId: string | null, eventType: string,
                               message: string, payload: Record<string, unknown> = {}, severity = 'info') {
  await sql`select public.log_event(${entityType}, ${entityId}, ${eventType}, ${message}, ${sql.json(payload as never)}, ${severity})`;
}
