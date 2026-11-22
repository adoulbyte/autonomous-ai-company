# Production setup (≈15 minutes, $0, no payment card)

Everything below uses free plans. Values go into **GitHub → repository → Settings → Secrets and variables → Actions → New repository secret**. Never paste them into chat or commit them.

## 1. Supabase (database, auth, realtime) — free plan, no card
1. Sign in at https://supabase.com/dashboard (GitHub sign-in is fine) → **New project** → Free plan. Choose a strong database password (store it in your password manager) and a region near you.
2. **Authentication → Sign In / Providers → Email**: keep Email enabled. **Authentication → Settings**: turn **off** “Allow new users to sign up”.
3. **Authentication → Users → Add user → Create new user**: your email + a strong password, tick **Auto Confirm User**.
4. **Project Settings → API** (or **Connect**): copy
   - Project URL → secret `VITE_SUPABASE_URL`
   - `anon` / publishable key → secret `VITE_SUPABASE_ANON_KEY` (public by design; RLS protects all data)
5. **Connect → Connection string → Session pooler** (IPv4; GitHub runners have no IPv6): copy the URI, replace `[YOUR-PASSWORD]` → secret `SUPABASE_DB_URL`.
6. Secret `OWNER_EMAIL` = the email from step 3.

Never use the `service_role` / secret key anywhere in this project.

## 2. Cloudflare (hosting the private web app) — free plan, no card
1. Sign up at https://dash.cloudflare.com/sign-up (free).
2. **Account ID**: shown on the Workers & Pages overview → secret `CLOUDFLARE_ACCOUNT_ID`.
3. **My Profile → API Tokens → Create Token → template “Edit Cloudflare Workers”** → restrict to your account → create → secret `CLOUDFLARE_API_TOKEN`.
4. The first deploy creates `https://aic-command-center.<your-subdomain>.workers.dev` (Cloudflare asks you to pick the workers.dev subdomain once in the dashboard if you have never used Workers).

## 3. Backups
Secret `BACKUP_PASSPHRASE` = a long random passphrase (store it in your password manager — backups cannot be decrypted without it).

## 4. Go live
1. Merge the development branch into `main` (scheduled workflows only run from the default branch).
2. **Actions → Deploy → Run workflow**: migrates the database, registers you as owner, builds and deploys the app.
3. **Actions → Worker → Run workflow** once to start the first discovery cycle (afterwards it runs every 2 hours).
4. Open the workers.dev URL, sign in, then **Settings → Two-factor authentication → Enroll**, and set `security.require_mfa` to `true`.

## Optional AI fallbacks (free tiers)
GitHub Models (via the Actions token) is the default and needs no setup. To add fallbacks, create free API keys and add secrets `GEMINI_API_KEY` (Google AI Studio; free-tier prompts may be used to improve Google products), `GROQ_API_KEY`, or `OPENROUTER_API_KEY`.

## Restore a backup
Download the `db-backup` artifact from the Backup workflow run, then:
```bash
gpg --decrypt aic-YYYYMMDDTHHMMSSZ.dump.gpg > restore.dump
pg_restore --clean --if-exists --no-owner --dbname "$SUPABASE_DB_URL" restore.dump
```
