import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { createEgressProxy } from '../server/scraper/egress.js';
import { isPublicScrapeAddress, parseScrapeUrl, resolveScrapeTarget } from '../server/scraper/security.js';
import { runScraperSandbox, type ScraperOperation } from '../server/scraper/sandbox.js';
import { inspectDom } from '../server/scraper/browser.js';

test('scraping rejects private, metadata, reserved, mapped and alternate-encoded targets', async () => {
  for (const address of ['127.0.0.1', '10.12.0.1', '172.31.255.254', '192.168.1.1', '169.254.169.254', '100.64.1.1', '192.0.2.1', '198.18.0.1', '203.0.113.2', '224.1.1.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1', '64:ff9b::7f00:1']) assert.equal(isPublicScrapeAddress(address), false, address);
  for (const url of ['http://localhost/', 'http://metadata.google.internal/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://[::1]/', 'https://public.example.com:8080/', 'file:///etc/passwd', 'http://user:password@example.com/', 'https://example.com/#fragment', 'http://redis/']) assert.throws(() => parseScrapeUrl(url), undefined, url);
  assert.equal(isPublicScrapeAddress('8.8.8.8'), true);
  assert.equal(isPublicScrapeAddress('2606:4700:4700::1111'), true);
  await assert.rejects(resolveScrapeTarget('https://mixed.example.com/', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.2', family: 4 }]), /private|reserved/);
  const target = await resolveScrapeTarget('https://public.example.com/path', async () => [{ address: '8.8.4.4', family: 4 }]);
  assert.equal(target.address, '8.8.4.4');
  assert.equal(target.url.pathname, '/path');
});

test('egress denies CONNECT and absolute HTTP requests to private or rebinding destinations', async () => {
  const server = createEgressProxy({ resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  const request = (payload: string) => new Promise<string>((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let output = '';
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Proxy test timed out.')); });
    socket.on('connect', () => socket.write(payload));
    socket.on('data', chunk => { output += chunk.toString(); });
    socket.on('error', reject);
    socket.on('end', () => resolve(output));
  });
  try {
    for (const authority of ['169.254.169.254:443', '127.0.0.1:443', '[::1]:443', 'public.example.com:22', 'mixed.example.com:443']) {
      assert.match(await request(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`), /^HTTP\/1\.1 403/);
    }
    assert.match(await request('GET http://mixed.example.com/path HTTP/1.1\r\nHost: mixed.example.com\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 403/);
  } finally { server.closeAllConnections(); server.close(); }
});

test('DOM inspection forces egress flags, bounds responses and rejects private targets before Browserless', async () => {
  const previous = { url: process.env.SCRAPER_BROWSERLESS_URL, token: process.env.SCRAPER_BROWSERLESS_TOKEN, proxy: process.env.SCRAPER_EGRESS_PROXY_URL };
  let requests = 0;
  let large = false;
  const server = http.createServer((request, response) => {
    requests++;
    const url = new URL(request.url!, 'http://browserless.example.com');
    assert.equal(url.pathname, '/chromium/content');
    const launch = JSON.parse(url.searchParams.get('launch')!);
    assert(launch.args.includes('--proxy-server=http://egress:8080'));
    assert(launch.args.includes('--proxy-bypass-list=<-loopback>'));
    assert(launch.args.includes('--disable-quic'));
    if (large) { response.writeHead(200, { 'content-length': 2_097_153 }).end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><h1>Public catalog</h1></body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.SCRAPER_BROWSERLESS_URL = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  process.env.SCRAPER_BROWSERLESS_TOKEN = 'test-browserless-token-no-real-credentials';
  process.env.SCRAPER_EGRESS_PROXY_URL = 'http://egress:8080';
  try {
    await assert.rejects(inspectDom('http://169.254.169.254/'), /private|reserved/);
    assert.equal(requests, 0);
    assert.match(await inspectDom('https://8.8.8.8/catalog'), /Public catalog/);
    assert.equal(requests, 1);
    large = true;
    await assert.rejects(inspectDom('https://8.8.8.8/catalog'), /2 MB/);
  } finally {
    for (const [key, value] of Object.entries({ SCRAPER_BROWSERLESS_URL: previous.url, SCRAPER_BROWSERLESS_TOKEN: previous.token, SCRAPER_EGRESS_PROXY_URL: previous.proxy })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.closeAllConnections(); server.close();
  }
});

test('isolated scraper extracts live locator data through only validated JSON operations', { timeout: 10_000 }, async () => {
  const operations: ScraperOperation[] = [];
  const result = await runScraperSandbox(`async function (page) {
    const rows = await page.locator('.product').all();
    return { url: page.url(), items: await Promise.all(rows.map(async row => ({
      name: (await row.locator('.name').textContent()).trim(),
      price: await row.getAttribute('data-price')
    }))) };
  }`, 'https://shop.example.com/', async operation => {
    operations.push(operation);
    if (operation.method === 'count') return 2;
    const row = operation.steps.find(step => step.kind === 'nth');
    if (operation.method === 'textContent') return row?.kind === 'nth' && row.index === 0 ? ' Shoe A ' : ' Shoe B ';
    return row?.kind === 'nth' && row.index === 0 ? '120' : '140';
  });
  assert.deepEqual(result, { url: 'https://shop.example.com/', items: [{ name: 'Shoe A', price: '120' }, { name: 'Shoe B', price: '140' }] });
  assert.equal(operations.length, 5);
  assert.equal(operations[0].method, 'count');
});

test('isolated code cannot obtain Node, network, browser navigation or host references', { timeout: 10_000 }, async () => {
  const result = await runScraperSandbox(`async page => ({
    process: typeof process, require: typeof require, fetch: typeof fetch,
    goto: typeof page.goto, evaluate: typeof page.evaluate,
    escape: page.locator.constructor('return typeof process')()
  })`, 'https://example.com/', async () => null);
  assert.deepEqual(result, { process: 'undefined', require: 'undefined', fetch: 'undefined', goto: 'undefined', evaluate: 'undefined', escape: 'undefined' });
});

test('isolate CPU loops, stalled promises, excessive operations and invalid selectors are bounded', { timeout: 15_000 }, async () => {
  const rpc = async () => 'a';
  await assert.rejects(runScraperSandbox('async page => { while (true) {} }', 'https://example.com/', rpc, { timeoutMs: 2500 }), /CPU|initialize|execution limit/);
  await assert.rejects(runScraperSandbox('async page => new Promise(() => {})', 'https://example.com/', rpc, { timeoutMs: 1500 }), /execution limit/);
  await assert.rejects(runScraperSandbox(`async page => { for(let i=0; i<257; i++) await page.locator('p').textContent(); return []; }`, 'https://example.com/', rpc), /action limit|256/);
  await assert.rejects(runScraperSandbox(`async page => page.locator('p').nth(-1).textContent()`, 'https://example.com/', rpc), /Row index/);
  await assert.rejects(runScraperSandbox(`async page => page.locator('p').getAttribute({bad: true})`, 'https://example.com/', rpc), /unsupported operation/);
});

test('isolate output byte limit and cancellation prevent unbounded results', { timeout: 10_000 }, async () => {
  await assert.rejects(runScraperSandbox(`async page => ({ value: '😀'.repeat(300000) })`, 'https://example.com/', async () => null), /1 MB|JSON/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runScraperSandbox('async page => []', 'https://example.com/', async () => null, { signal: controller.signal }), /cancelled/);
});
