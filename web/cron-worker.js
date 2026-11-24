// Reliable clock for the agents: Cloudflare Cron Triggers (free) start the GitHub "Worker" workflow every 20 minutes.
// GitHub's own schedules can be delayed or skipped for hours; this one is not. Static pages are still served as assets.
export default {
  async scheduled(_event, env, ctx) {
    if (!env.DISPATCH_TOKEN || !env.GITHUB_REPO) return;   // not configured yet: nothing to do
    ctx.waitUntil(fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/worker.yml/dispatches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.DISPATCH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'command-center-cron', 'x-github-api-version': '2022-11-28' },
      body: JSON.stringify({ ref: 'main' }),
    }).then(async (r) => { if (!r.ok) console.log(`dispatch failed: ${r.status} ${(await r.text()).slice(0, 200)}`); }));
  },
  async fetch(request, env) { return env.ASSETS.fetch(request); },
};
