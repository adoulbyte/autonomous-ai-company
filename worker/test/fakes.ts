/**
 * TEST DOUBLES ONLY. A fake OpenAI-compatible endpoint and a fake HN API used to test the
 * pipeline deterministically offline. Live tests (test/live.test.ts) use the real services.
 */
export type Responder = (prompt: string, model: string) => { status?: number; body?: unknown; content?: string; headers?: Record<string, string> };

export function fakeFetch(routes: { ai?: Responder; json?: Record<string, unknown> }) {
  const calls: { url: string; model?: string; prompt?: string }[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body));
      const prompt = body.messages.map((m: { content: string }) => m.content).join('\n');
      calls.push({ url, model: body.model, prompt });
      // The daily marketing review runs in every cycle: a neutral exploration plan unless a test answers it itself.
      const marketing: ReturnType<Responder> | null = prompt.includes('You are the marketing strategist') ? { body: { summary: 'Plan d’exploration.', focus_categories: [], deprioritize_categories: [], writing_tips: [],
        country_weights: { FR: 2, GB: 1 }, zones_per_city: 5, geo_reason: 'Test.' } } : null;
      const own = routes.ai?.(prompt, body.model);
      const r: ReturnType<Responder> = (own && !(own.status && own.status >= 400) ? own : marketing ?? own) ?? { status: 500 };
      if (r.status && r.status !== 200) return new Response(JSON.stringify(r.body ?? { error: 'fake error' }), { status: r.status, headers: r.headers });
      return Response.json({ choices: [{ message: { content: r.content ?? JSON.stringify(r.body) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
    }
    calls.push({ url });
    for (const [prefix, payload] of Object.entries(routes.json ?? {})) {
      if (url.startsWith(prefix)) return Response.json(payload);
    }
    return new Response('not found', { status: 404 });
  };
  return { fn: fn as typeof fetch, calls };
}

const now = Date.now();
export const HN_SEARCH = { hits: [{ objectID: '90000001', title: 'Ask HN: Freelancer? Seeking freelancer? (November 2026)', created_at: new Date(now - 5 * 86400000).toISOString() }] };
export const HN_ITEM = {
  id: 90000001, author: 'whoishiring', text: null, created_at: new Date(now - 5 * 86400000).toISOString(),
  children: [
    { id: 90000010, author: 'acme_ops', created_at: new Date(now - 2 * 86400000).toISOString(), children: [],
      text: 'SEEKING FREELANCER | Acme Logistics | Remote<p>We need a Python developer to build a small automation that reads our daily CSV exports of shipments, validates rows, and produces a summary report (Markdown) plus a cleaned CSV. Budget around $800. Contact: ops@acme-logistics.example' },
    { id: 90000011, author: 'dev_person', created_at: new Date(now - 2 * 86400000).toISOString(), children: [],
      text: 'SEEKING WORK | Remote | Python, Go<p>I build backends.' },
    { id: 90000012, author: 'bakery', created_at: new Date(now - 1 * 86400000).toISOString(), children: [],
      text: 'SEEKING FREELANCER | Sweet Bakery | Onsite Paris<p>Need a pastry chef for weekend shifts.' },
  ],
};
