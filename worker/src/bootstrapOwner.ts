import { connect } from './db.js';

/**
 * Registers the single owner. The owner's Supabase Auth user must already exist
 * (created in the Supabase dashboard; public sign-ups disabled). Idempotent.
 */
const url = process.env.DATABASE_URL; const email = process.env.OWNER_EMAIL;
if (!url || !email) { console.error('DATABASE_URL and OWNER_EMAIL are required'); process.exit(1); }
const sql = connect(url, { max: 1 });
try {
  const users = await sql`select id, email from auth.users where lower(email) = lower(${email})`;
  if (!users.length) {
    console.error('No Supabase Auth user with OWNER_EMAIL exists yet. Create it in Supabase → Authentication → Users → Add user (auto-confirm), then re-run.');
    process.exitCode = 2;
  } else {
    const [existing] = await sql`select user_id from public.app_owner`;
    if (existing && existing.user_id !== users[0].id) {
      console.error('A different owner is already registered. Refusing to replace it automatically.');
      process.exitCode = 3;
    } else {
      await sql`insert into public.app_owner(user_id, email) values (${users[0].id}, ${users[0].email}) on conflict (singleton) do nothing`;
      console.log('Owner registered.');
    }
  }
} finally { await sql.end({ timeout: 5 }); }
