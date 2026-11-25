// Read-only production diagnostics: aggregated counts only (no names, emails or message bodies are printed).
import { loadConfig } from '../config.js';
import { connect } from '../db.js';

const sql = connect(loadConfig().databaseUrl);
const show = (title: string, rows: unknown) => console.log(`\n== ${title}\n${JSON.stringify(rows, null, 1)}`);
try {
  show('opportunities by status/decision', await sql`select status, decision, count(*)::int n from public.opportunities group by 1,2 order by 3 desc`);
  show('opportunities by source', await sql`select source_key, count(*)::int n, count(*) filter (where buyer_contact ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')::int with_email from public.opportunities group by 1 order by 2 desc`.catch((e) => String(e.message)));
  show('top decision reasons', await sql`select left(regexp_replace(reason, ':.*$', ''), 80) reason, count(*)::int n from public.opportunities, unnest(decision_reasons) reason group by 1 order by 2 desc limit 15`);
  show('score distribution', await sql`select width_bucket(score, 0, 100, 10) bucket, count(*)::int n from public.opportunities where score is not null group by 1 order by 1`);
  show('leads by stage', await sql`select stage, count(*)::int n from public.leads group by 1`);
  show('messages by direction/status', await sql`select direction, status, count(*)::int n from public.messages group by 1,2`);
  show('approvals by type/status', await sql`select action_type, status, count(*)::int n from public.approvals group by 1,2 order by 3 desc`);
  show('tasks by type/status', await sql`select type, status, count(*)::int n from public.tasks group by 1,2 order by 1,2`);
  show('sources', await sql`select key, kind, enabled, health, consecutive_failures, left(last_error, 200) last_error, items_found_total, next_run_at from public.sources order by key`);
  show('discovery results (latest per source)', await sql`select distinct on (input->>'source_key') input->>'source_key' src, status, output, finished_at from public.tasks where type = 'discovery.run_source' order by input->>'source_key', created_at desc`.catch((e) => String(e.message)));
  show('task errors', await sql`select type, status, left(regexp_replace(error, '(:.*$)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)', '', 'g'), 90) err, count(*)::int n from public.tasks where error is not null group by 1,2,3 order by 4 desc limit 15`);
  show('pending task age', await sql`select type, min(created_at) oldest, min(run_after) next_run_after from public.tasks where status = 'pending' group by 1`.catch((e) => String(e.message)));
  show('settings', await sql`select key, value from public.settings where key in ('business.mode','comms.policy','scoring.rules','system.kill_switch','autonomy.policy')`);
  show('worker heartbeats', await sql`select worker_id, status, last_seen_at, tasks_succeeded, tasks_failed, note from public.worker_heartbeats order by last_seen_at desc limit 8`);
  // Public-safe: counts only (no addresses, names or subjects).
  show('outbound emails by status', await sql`select status, count(*)::int n, max(sent_at) last_sent from public.messages where direction = 'outbound' group by 1`);
  show('inbound emails by category', await sql`select coalesce(classification->>'category', 'unclassified') category, count(*)::int n from public.messages where direction = 'inbound' group by 1`);
  show('inbound linked to prospects (public-safe)', await sql`select m.created_at, m.classification->>'category' category, m.classification->>'intent' intent,
      (m.from_addr ~* '(mailer-daemon|postmaster|no-?reply)') as automated, l.stage
      from public.messages m join public.conversations c on c.id = m.conversation_id join public.leads l on l.id = c.lead_id where m.direction = 'inbound' order by m.created_at desc limit 20`);
  // Why a prospect has not received its first email yet (counts only).
  show('leads waiting for a first email', await sql`select l.stage, coalesce(m.status, 'no draft yet') first_message, coalesce(t.status, 'no task') outreach_task,
      left(regexp_replace(coalesce(t.error, ''), '(:.*$)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)', '', 'g'), 80) task_error, count(*)::int n, min(l.created_at) oldest
      from public.leads l
      left join lateral (select m.status from public.messages m join public.conversations c on c.id = m.conversation_id where c.lead_id = l.id and m.idempotency_key like 'outreach:%' limit 1) m on true
      left join lateral (select t.status, t.error from public.tasks t where t.entity_id::text = l.id::text and t.type like 'lead.%' and t.type not in ('lead.followup','lead.mockup','lead.proposal_reminder','lead.respond') order by t.created_at desc limit 1) t on true
      where l.stage in ('new','qualified') group by 1,2,3,4 order by 5 desc`.catch((e) => String(e.message)));
  show('first-email drafting failures by cause', await sql`select case when error ~* 'quality bar' then 'review score too low twice' when error ~* 'compliance gate' then 'compliance/spam gate: ' || coalesce(substring(error from 'gate: ([a-z /-]{3,40})'), '?')
      when error ~* 'timeout|timed out' then 'timeout' when error ~* 'no AI model|unavailable|rate' then 'AI providers unavailable' else 'other' end cause, attempts, count(*)::int n, max(created_at) last
      from public.tasks where type = 'lead.draft_outreach' and status = 'dead' group by 1, 2`.catch((e) => String(e.message)));
  show('first emails sent today vs daily cap', await sql`select (select count(*)::int from public.messages where direction = 'outbound' and status = 'sent' and idempotency_key like 'outreach:%' and sent_at >= date_trunc('day', now())) sent_today,
      (select count(*)::int from public.messages where direction = 'outbound' and status = 'approved' and idempotency_key like 'outreach:%') approved_waiting,
      (select value from public.settings where key = 'prospecting.policy') policy`.catch((e) => String(e.message)));
  show('mailbox', await sql`select last_poll_at, last_error is not null as has_error from public.mailbox_state`);
} catch (e) { console.error('diagnose failed:', (e as Error).message); process.exitCode = 1; }
finally { await sql.end({ timeout: 5 }); }
