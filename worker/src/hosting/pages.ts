import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Publication of a client's website on Cloudflare Pages (free plan, HTTPS included), with the account already used by the
 * platform. HOSTING_DRY_RUN=1 (tests) simulates the publication without calling Cloudflare.
 */
export function pagesProjectName(businessName: string): string {
  const slug = businessName.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
  return /^[a-z]/.test(slug) ? slug : `site-${slug}`;
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 180_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('npx', ['--yes', 'wrangler@4', ...args], { cwd, env: { ...process.env, ...env, CI: '1' } });
    let out = ''; const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, out: out.slice(-4000) }); });
    p.on('error', () => { clearTimeout(t); resolve({ code: 1, out: 'wrangler could not start' }); });
  });
}

/** Publishes index.html (+ optional files) and returns the public address. */
export async function publishSite(project: string, html: string, env: NodeJS.ProcessEnv): Promise<string> {
  const url = `https://${project}.pages.dev`;
  if (env.HOSTING_DRY_RUN === '1') return url;
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) throw new Error('Cloudflare credentials missing: the site cannot be published');
  const dir = mkdtempSync(join(tmpdir(), 'site-'));
  try {
    writeFileSync(join(dir, 'index.html'), html);
    await run(['pages', 'project', 'create', project, '--production-branch', 'main'], env, dir);   // already exists: fine
    const r = await run(['pages', 'deploy', '.', '--project-name', project, '--branch', 'main', '--commit-dirty=true'], env, dir);
    if (r.code !== 0) {
      const hint = /authentication|permission|10000|403/i.test(r.out) ? ' (the Cloudflare token needs the "Cloudflare Pages: Edit" permission)' : '';
      throw new Error(`publication failed${hint}: ${r.out.replace(/https?:\/\/\S+/g, '<url>').slice(-300)}`);
    }
    return url;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Attaches a custom domain (e.g. www.salon-belle.fr) to the published site. */
export async function connectDomain(project: string, domain: string, env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch): Promise<void> {
  if (env.HOSTING_DRY_RUN === '1') return;
  const r = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${project}/domains`, {
    method: 'POST', headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: domain }) });
  const b = (await r.json().catch(() => ({}))) as { success?: boolean; errors?: { code: number; message: string }[] };
  if (!b.success && !(b.errors ?? []).some((e) => /already/i.test(e.message))) throw new Error(`domain connection failed: ${(b.errors ?? []).map((e) => e.message).join('; ').slice(0, 300)}`);
}

const TLD: Record<string, string> = { FR: 'fr', BE: 'be', LU: 'lu', MC: 'mc', GB: 'co.uk', IE: 'ie', NL: 'nl', PT: 'pt', MA: 'ma', TN: 'tn', SN: 'sn', CI: 'ci', CA: 'ca', AU: 'com.au', NZ: 'co.nz', US: 'com' };

/** A short, available domain name for the business (public RDAP lookup: "not found" = available). Null when unsure. */
export async function suggestDomain(name: string, city: string | null | undefined, country = 'FR', fetchFn: typeof fetch = fetch): Promise<string | null> {
  const base = pagesProjectName(name).replace(/^site-/, '').replace(/-(sarl|sas|eurl|sa)$/, '');
  const c = city ? pagesProjectName(city) : '';
  const tld = TLD[country] ?? 'com';
  const candidates = [...new Set([`${base}.${tld}`, c ? `${base}-${c}.${tld}` : '', tld !== 'com' ? `${base}.com` : ''].filter((d) => d && d.length <= 63))];
  for (const d of candidates) {
    try {
      const r = await fetchFn(`https://rdap.org/domain/${d}`, { headers: { accept: 'application/rdap+json' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
      if (r.status === 404) return d;
    } catch { /* unknown: try the next one */ }
  }
  return null;
}
