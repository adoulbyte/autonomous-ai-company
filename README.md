# autonomous-ai-company

A private, single-owner, AI-operated business system: it discovers real opportunities, evaluates them with explainable scoring, manages leads, plans and produces deliverables with AI agents, verifies them with an independent QA agent, tracks evidence-backed finances, and keeps the owner in control through database-enforced approvals.

**Infrastructure cost: $0** — Supabase Free (Postgres/Auth/Realtime), Cloudflare Workers Free (static app), GitHub Actions (worker, CI, deploy, backups), GitHub Models free tier (AI via the Actions token).

## Architecture
```
Browser (owner) ──HTTPS──► Cloudflare Workers static assets (React SPA, no secrets)
      │ supabase-js (anon key + owner JWT)
      ▼
Supabase Postgres ◄── RLS on every table, owner-only RPCs, approvals, state machines,
      ▲                append-only audit/event logs, pg_cron maintenance (5 min)
      │ session pooler (DATABASE_URL secret)
GitHub Actions "Worker" (every 2h, bounded ≤8 min): scheduler → claim (SKIP LOCKED + lease)
      → agent handler → AI gateway (GitHub Models → optional fallbacks) → transactional commit
```
- `supabase/migrations/` — schema, durable queue (`enqueue_task`, `claim_tasks`, `complete_task`, `fail_task`, `defer_task`, `recover_expired_leases`), approvals (`decide_approval`), owner RPCs, finance guards, RLS.
- `worker/` — TypeScript worker: AI gateway (`src/ai`), connectors (`src/connectors`), agents (`src/agents`), scoring (`src/scoring.ts`), runtime (`src/runtime.ts`).
- `web/` — React command center (17 pages).
- `.github/workflows/` — `ci` (tests + browser e2e on a real local Supabase), `live-e2e` (real sources + real AI), `worker`, `deploy`, `backup`.

## Guarantees enforced by the database (not the UI)
- Only the registered owner (optionally with MFA/aal2) can read data or call actions; anon has no access.
- Outbound messages cannot become approved/sent without an approved approval.
- Payments cannot be `confirmed` without evidence type + reference + confirmer; agents can never confirm payments.
- Deliverables cannot be approved without a passing QA review from a different role/task than the producer.
- Opportunities cannot advance without stored evidence; all status changes follow declared state machines.
- Tasks are idempotent (unique keys), leased, retried with backoff, dead-lettered, fan-out limited, and halted by the kill switch.

Setup: see [docs/SETUP.md](docs/SETUP.md). Run tests locally: `cd worker && TEST_DATABASE_URL=postgres://… npx vitest run`.
