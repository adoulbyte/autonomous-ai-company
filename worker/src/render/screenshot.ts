import { existsSync } from 'node:fs';

/** Chrome/Chromium already present on the machine (GitHub runners ship Google Chrome); nothing is downloaded. */
function browserPath(env: NodeJS.ProcessEnv): string | null {
  const candidates = [env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium'];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

/**
 * Screenshots (JPEG) of a page: the whole page on a desktop (capped in height) and the first screen on a phone,
 * or the square visual for a social post. Only images, fonts and stylesheets may load; scripts never run.
 * Returns null when no browser is available.
 */
export async function screenshotHtml(html: string, env: NodeJS.ProcessEnv = process.env, kind: 'site' | 'post' = 'site'): Promise<{ desktop: Buffer; mobile: Buffer | null } | null> {
  const exe = browserPath(env);
  if (!exe || env.DISABLE_SCREENSHOTS === '1') return null;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  try {
    const shot = async (width: number, height: number, scale: number, maxHeight: number) => {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale, javaScriptEnabled: false });
      await page.route('**/*', (r) => {
        const req = r.request(); const url = req.url();
        if (url.startsWith('data:') || url === 'about:blank') return r.continue();
        return /^https:\/\//.test(url) && ['image', 'font', 'stylesheet'].includes(req.resourceType()) ? r.continue() : r.abort();
      });
      await page.setContent(html, { waitUntil: 'load', timeout: 45000 }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
      const box = await page.locator('body').boundingBox().catch(() => null);
      const h = Math.min(maxHeight, Math.max(height, Math.ceil(box?.height ?? height)));
      const buf = await page.screenshot({ type: 'jpeg', quality: 74, fullPage: h > height, clip: { x: 0, y: 0, width, height: h } });
      await page.close();
      return buf;
    };
    if (kind === 'post') return { desktop: await shot(1080, 1080, 1, 1080), mobile: null };
    return { desktop: await shot(1280, 800, 1, 3000), mobile: await shot(390, 800, 2, 800) };
  } finally { await browser.close(); }
}
