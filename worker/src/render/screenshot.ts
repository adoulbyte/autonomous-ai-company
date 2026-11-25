import { existsSync } from 'node:fs';

/** Chrome/Chromium already present on the machine (GitHub runners ship Google Chrome); nothing is downloaded. */
function browserPath(env: NodeJS.ProcessEnv): string | null {
  const candidates = [env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium'];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

/** Desktop and phone screenshots (JPEG) of a self-contained HTML page. Returns null when no browser is available. */
export async function screenshotHtml(html: string, env: NodeJS.ProcessEnv = process.env): Promise<{ desktop: Buffer; mobile: Buffer } | null> {
  const exe = browserPath(env);
  if (!exe || env.DISABLE_SCREENSHOTS === '1') return null;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  try {
    const shot = async (width: number, height: number, scale: number) => {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale, javaScriptEnabled: false });
      await page.route('**/*', (r) => (r.request().url().startsWith('data:') || r.request().url() === 'about:blank' ? r.continue() : r.abort()));   // no external requests
      await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
      const buf = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
      await page.close();
      return buf;
    };
    return { desktop: await shot(1200, 760, 1), mobile: await shot(390, 760, 2) };
  } finally { await browser.close(); }
}
