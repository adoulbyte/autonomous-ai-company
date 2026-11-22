import postgres from 'postgres';

export type Sql = postgres.Sql<Record<string, unknown>>;
export type Tx = postgres.TransactionSql<Record<string, unknown>>;

export interface ParsedDbUrl { host: string; port: number; database: string; username: string; password: string; params: URLSearchParams }

/**
 * Parse a Postgres connection string tolerantly: trims whitespace/quotes, accepts passwords containing
 * unencoded special characters (@ # / ? : %) by splitting on the LAST '@', and rejects leftover
 * placeholders like [YOUR-PASSWORD]. Never includes the password in error messages.
 */
export function parseDbUrl(raw: string): ParsedDbUrl {
  const url = raw.trim().replace(/^['"]|['"]$/g, '').trim();
  const m = url.match(/^postgres(?:ql)?:\/\/([^:/?#@]+)(?::(.*))?@([^@/?#]+?)(?::(\d+))?\/([^?#/]+)(?:\?(.*))?$/s);
  if (!m) {
    const shape = url.replace(/:\/\/[^@]*@/, '://<user>:<password>@').replace(/[A-Za-z0-9]/g, (c, i) => (i < 14 ? c : 'x'));
    throw new Error(`DATABASE_URL is not a valid postgres connection string (expected postgresql://USER:PASSWORD@HOST:PORT/DATABASE). Shape received: ${shape.slice(0, 80)}`);
  }
  const [, username, password, host, port, database, query] = m;
  if (password && (/^\[.*\]$/.test(password) || /YOUR-PASSWORD/i.test(password))) throw new Error('DATABASE_URL still contains the [YOUR-PASSWORD] placeholder: replace it (without brackets) with the database password.');
  let pw = password ?? '';
  try { pw = decodeURIComponent(pw); } catch { /* raw special characters: use as-is */ }
  return { host, port: Number(port ?? 5432), database, username: decodeURIComponent(username), password: pw, params: new URLSearchParams(query ?? '') };
}

export function connect(url: string, opts: { max?: number } = {}): Sql {
  const p = parseDbUrl(url);
  const local = /^(localhost|127\.0\.0\.1|::1)$/.test(p.host) || p.params.get('sslmode') === 'disable';
  return postgres({
    host: p.host, port: p.port, database: p.database, username: p.username, password: p.password,
    max: opts.max ?? 4,
    prepare: false,              // compatible with Supabase poolers
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
    ssl: local ? false : 'require',
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
