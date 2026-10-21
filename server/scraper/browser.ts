import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { runScraperSandbox, type ScraperOperation } from './sandbox.js';
import { assertNotAborted, MAX_DOM_BYTES, resolveScrapeTarget, scrapeDeadline, SCRAPE_TIMEOUT_MS, withScrapeAbort } from './security.js';

function browserlessEndpoint(path: string, websocket = false): URL {
  const token = process.env.SCRAPER_BROWSERLESS_TOKEN;
  if (!token || token.length < 16) throw new Error('Configure SCRAPER_BROWSERLESS_TOKEN to enable website extraction.');
  let base: URL;
  let proxy: URL;
  try {
    base = new URL(process.env.SCRAPER_BROWSERLESS_URL ?? 'http://browserless:3000');
    proxy = new URL(process.env.SCRAPER_EGRESS_PROXY_URL ?? 'http://egress:8080');
  } catch { throw new Error('The managed browser configuration is invalid.'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || proxy.protocol !== 'http:' || proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== '/') throw new Error('The managed browser configuration is invalid.');
  base.protocol = websocket ? (['https:', 'wss:'].includes(base.protocol) ? 'wss:' : 'ws:') : (['https:', 'wss:'].includes(base.protocol) ? 'https:' : 'http:');
  base.pathname = path;
  base.searchParams.set('token', token);
  base.searchParams.set('timeout', String(SCRAPE_TIMEOUT_MS));
  base.searchParams.set('launch', JSON.stringify({
    headless: true,
    args: [`--proxy-server=${proxy.origin}`, '--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  }));
  return base;
}

/** Inspect rendered content through the same public-only egress boundary as execution. */
export async function inspectDom(targetUrl: string, signal?: AbortSignal): Promise<string> {
  const deadline = scrapeDeadline(signal);
  try {
    const target = await withScrapeAbort(resolveScrapeTarget(targetUrl), deadline.signal);
    const response = await fetch(browserlessEndpoint('/chromium/content'), {
      method: 'POST', redirect: 'error', signal: deadline.signal,
      headers: { 'content-type': 'application/json', accept: 'text/html' },
      body: JSON.stringify({ url: target.url.href, gotoOptions: { waitUntil: 'networkidle2', timeout: 12_000 }, rejectResourceTypes: ['image', 'media', 'font', 'websocket', 'eventsource'], bestAttempt: false }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 429 ? 'The managed browser is busy. Try again shortly.' : 'The managed browser could not inspect this website.'); }
    if (Number(response.headers.get('content-length') ?? 0) > MAX_DOM_BYTES) { await response.body?.cancel(); throw new Error('The rendered page exceeds the 2 MB inspection limit.'); }
    if (!response.body) throw new Error('The website returned no inspectable content.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_DOM_BYTES) { await reader.cancel(); throw new Error('The rendered page exceeds the 2 MB inspection limit.'); }
      chunks.push(value);
    }
    const html = Buffer.concat(chunks).toString('utf8');
    if (!html.trim()) throw new Error('The website returned no inspectable content.');
    return html;
  } catch (error) {
    if (deadline.signal.aborted) throw new Error('Website inspection exceeded its execution time limit or was cancelled.');
    // Fetch/Playwright exceptions can include the Browserless connection token.
    if (error instanceof Error && /^(The |Configure |Enter |Only |Local[, ]|Scraping )/.test(error.message) && !error.message.includes('token=')) throw error;
    throw new Error('Website inspection failed. Check the target and managed browser configuration.');
  } finally { deadline.dispose(); }
}

async function operationForPage(page: Page, operation: ScraperOperation): Promise<unknown> {
  let locator: Locator | undefined;
  for (const step of operation.steps) {
    if (step.kind === 'locator') locator = locator ? locator.locator(step.selector) : page.locator(step.selector);
    else { if (!locator) throw new Error('A selector is required before choosing a row.'); locator = locator.nth(step.index); }
  }
  if (!locator) throw new Error('A valid selector is required.');
  if (operation.method === 'count') return Math.min(await locator.count(), 200);
  if (operation.method === 'allTextContents') return locator.evaluateAll(elements => elements.slice(0, 200).map(element => (element.textContent ?? '').slice(0, 65_536)));
  if (await locator.count() === 0) return null;
  if (operation.method === 'textContent') return locator.evaluate(element => element.textContent === null ? null : element.textContent.slice(0, 65_536), undefined, { timeout: 1500 });
  if (operation.method === 'innerText') return locator.evaluate(element => ('innerText' in element ? String(element.innerText) : element.textContent ?? '').slice(0, 65_536), undefined, { timeout: 1500 });
  return locator.evaluate((element, attribute) => element.getAttribute(attribute)?.slice(0, 65_536) ?? null, operation.attribute!, { timeout: 1500 });
}

/** Execute extraction against a fresh browser context; generated code cannot navigate. */
export async function executeScraper(targetUrl: string, code: string, signal?: AbortSignal): Promise<unknown> {
  const deadline = scrapeDeadline(signal);
  const started = Date.now();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let aborted = false;
  const close = () => { aborted = true; void context?.close().catch(() => {}); void browser?.close().catch(() => {}); };
  deadline.signal.addEventListener('abort', close, { once: true });
  try {
    const target = await withScrapeAbort(resolveScrapeTarget(targetUrl), deadline.signal);
    const connection = chromium.connectOverCDP(browserlessEndpoint('/chromium', true).href, { timeout: Math.max(1, SCRAPE_TIMEOUT_MS - (Date.now() - started)) });
    // If cancellation wins the race while connecting, close the eventual connection.
    connection.then(connected => { if (aborted) void connected.close().catch(() => {}); }).catch(() => {});
    browser = await withScrapeAbort(connection, deadline.signal);
    context = await withScrapeAbort(browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: false }), deadline.signal);
    const blockedRequests: string[] = [];
    let requests = 0;
    await context.route('**/*', async route => {
      try {
        if (++requests > 120 || deadline.signal.aborted) { await route.abort('blockedbyclient'); return; }
        const request = route.request();
        if (['image', 'media', 'font'].includes(request.resourceType())) { await route.abort('blockedbyclient'); return; }
        await withScrapeAbort(resolveScrapeTarget(request.url()), deadline.signal);
        await route.continue();
      } catch { blockedRequests.push('blocked'); await route.abort('blockedbyclient').catch(() => {}); }
    });
    await context.routeWebSocket('**/*', websocket => websocket.close());
    const page = await withScrapeAbort(context.newPage(), deadline.signal);
    page.setDefaultTimeout(1500);
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    page.on('popup', popup => { void popup.close().catch(() => {}); });
    const response = await withScrapeAbort(page.goto(target.url.href, { waitUntil: 'domcontentloaded', timeout: Math.max(1, 11_000 - (Date.now() - started)) }), deadline.signal);
    if (!response || response.status() >= 400) throw new Error('The target website denied access or returned an error.');
    // Give client-rendered lists a bounded opportunity to finish loading.
    await withScrapeAbort(page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {}), deadline.signal);
    await withScrapeAbort(resolveScrapeTarget(page.url()), deadline.signal);
    if (blockedRequests.length && page.url() === 'about:blank') throw new Error('The target attempted to access a private network.');
    assertNotAborted(deadline.signal);
    return await runScraperSandbox(code, page.url(), operation => withScrapeAbort(operationForPage(page, operation), deadline.signal), { signal: deadline.signal, timeoutMs: SCRAPE_TIMEOUT_MS - (Date.now() - started) });
  } catch (error) {
    if (deadline.signal.aborted) throw new Error('Scrape exceeded its 15 second execution limit or was cancelled.');
    if (error instanceof Error && /^(The |Configure |Enter |Only |Local[, ]|Scraping |Generated |Scraper |Scrape )/.test(error.message) && !error.message.includes('token=')) throw error;
    throw new Error('Scrape failed. Check the target, selectors and managed browser configuration.');
  } finally {
    deadline.signal.removeEventListener('abort', close);
    deadline.dispose();
    // No cached cookies, storage state or shared pages survive an execution.
    void Promise.allSettled([context?.close(), browser?.close()]);
  }
}
