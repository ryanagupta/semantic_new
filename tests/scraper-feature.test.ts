import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'relay-scraper-test-')), 'test.db');
process.env.SCRAPER_ENABLED = 'false';
delete process.env.REDIS_URL;
const { scraperStore, ScraperStore } = await import('../server/scraper/store.js');
const { store } = await import('../server/store.js');
const { billingStore } = await import('../server/billing/store.js');
const { inferOutputSchema, verifyOutput, validateStoredOutput } = await import('../server/scraper/schema.js');
const { signScraperIdentity } = await import('../server/scraper/identity.js');
const { createApp } = await import('../server/app.js');
const { generateScraper } = await import('../server/agent/generator.js');
const { scraperOpenApi } = await import('../server/scraper/openapi.js');
const input = { targetUrl: 'https://example.com/products', prompt: 'Extract product names and prices as an array of records.', cacheTtlSeconds: 300 };
const artifact = { name: 'Product prices', description: 'Public product names and prices.', code: 'async page => [{name: await page.locator("h1").textContent(), price: 12}]', sample: [{ name: 'Shoe', price: 12 }], schema: inferOutputSchema([{ name: 'Shoe', price: 12 }]) };
after(() => { scraperStore.close(); store.close(); billingStore.close(); });

test('sample schema preserves nullability, optional fields, mixed arrays and drift validation', () => {
  const sample = [{ name: 'Shoe', price: 12, stock: null }, { name: 'Sock', price: 2.5, stock: true, size: 'M' }];
  const schema = verifyOutput(sample, ['name', 'price', 'stock']);
  validateStoredOutput(schema, sample);
  assert.throws(() => validateStoredOutput(schema, [{ name: 'Shoe', price: 'twelve', stock: true }]), /source changed/);
  assert.throws(() => verifyOutput([], ['name']), /No usable/);
  assert.throws(() => verifyOutput([{ wrong: 1 }], ['name']), /missing/);
  assert.throws(() => inferOutputSchema(JSON.parse('{"__proto__":1}')), /Unsafe/);
  assert.throws(() => verifyOutput(Array.from({ length: 201 }, () => ({ name: 'Shoe' }))), /200/);
  validateStoredOutput(inferOutputSchema([1, 'x', null, false]), [2, 'y', null, true]);
  validateStoredOutput(inferOutputSchema({ name: 'Shoe', empty: null }), { name: 'Sock', empty: null });
});

test('durable jobs publish endpoint, MCP definition and scoped key atomically; reveal is one-time', () => {
  const job = scraperStore.createJob('alice', input);
  assert.equal(scraperStore.getJob(job.id, 'bob'), undefined);
  const claimed = scraperStore.claim()!; assert.equal(claimed.id, job.id);
  assert.equal(scraperStore.claim(), undefined);
  const endpoint = scraperStore.complete(claimed, artifact, 60);
  assert.equal(scraperStore.get(endpoint.id, 'bob'), undefined);
  assert.equal(store.getEndpoint(endpoint.id)?.method, 'GET');
  const key = scraperStore.reveal(job.id, 'alice');
  const principal = store.authenticateKey(key)!;
  assert.deepEqual(principal.scopes, [`tool:${store.getEndpoint(endpoint.id)!.name}`, 'tools:read']);
  assert.throws(() => scraperStore.reveal(job.id, 'alice'), /already revealed/);
  assert.throws(() => scraperStore.reveal(job.id, 'bob'), /already revealed/);
  assert.throws(() => scraperStore.complete(claimed, artifact, 60), /lease expired/);
  const reopened = new ScraperStore(process.env.DATABASE_PATH);
  assert.equal(reopened.get(endpoint.id, 'alice')?.name, artifact.name); reopened.close();
  const spec = scraperOpenApi(endpoint);
  assert.equal(spec.openapi, '3.0.3'); assert.ok(spec.paths[`/api/v1/custom/${endpoint.id}`]);
  scraperStore.setEnabled(endpoint.id, 'alice', false);
  assert.equal(store.getEndpoint(endpoint.id)?.enabled, false);
  assert.throws(() => scraperStore.setEnabled(endpoint.id, 'bob', true), /not found/);
  scraperStore.delete(endpoint.id, 'alice');
  assert.equal(store.authenticateKey(key), undefined);
  assert.equal(store.getEndpoint(endpoint.id), undefined);
});

test('crashed workers recover expired leases and stale workers cannot publish', () => {
  const job = scraperStore.createJob('alice', input), original = scraperStore.claim()!;
  const db = new DatabaseSync(process.env.DATABASE_PATH!);
  db.prepare('UPDATE scraper_jobs SET lease_until=0 WHERE id=?').run(job.id); db.close();
  const recovered = scraperStore.claim()!;
  assert.equal(recovered.id, original.id); assert.notEqual(recovered.lease, original.lease);
  assert.equal(scraperStore.heartbeat(original), false);
  assert.throws(() => scraperStore.complete(original, artifact, 60), /lease expired/);
  scraperStore.fail(recovered, 'Test failed intentionally.');
  assert.equal(scraperStore.getJob(job.id)?.status, 'failed');
});

test('agent loop repairs live extraction failures and stops after exactly three repairs', async () => {
  let modelCalls = 0, executions = 0;
  const fetchModel: typeof fetch = async (_url, init) => {
    modelCalls++;
    const request = JSON.parse(String(init?.body));
    assert.equal(request.provider.require_parameters, true);
    assert.equal(request.response_format.json_schema.strict, true);
    if (modelCalls > 1) assert.match(request.messages.at(-1).content, /verificationError/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ name: artifact.name, description: artifact.description, code: artifact.code, outputFields: ['name', 'price'] }) } }] });
  };
  const dependencies = { fetch: fetchModel, inspectDom: async () => '<html><h1>Shoe</h1></html>', executeScraper: async () => { executions++; if (executions === 1) throw new Error('Selector did not match.'); return artifact.sample; } };
  const result = await generateScraper(input, () => {}, undefined, dependencies);
  assert.deepEqual(result.sample, artifact.sample); assert.equal(modelCalls, 2);
  modelCalls = 0;
  await assert.rejects(generateScraper(input, () => {}, undefined, { ...dependencies, executeScraper: async () => [] }), /after three repairs/);
  assert.equal(modelCalls, 4);
});

test('management requires signed-in account assertion plus owner session; endpoint keys stay scoped', async () => {
  const job = scraperStore.createJob('alice', input), claimed = scraperStore.claim()!;
  const endpoint = scraperStore.complete(claimed, artifact, 60);
  const server = createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(base + '/api/session');
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(base + '/api/scrapers', { headers: { cookie } })).status, 401);
    const alice = { cookie, 'x-relay-scraper-identity': await signScraperIdentity('alice') };
    const bob = { cookie, 'x-relay-scraper-identity': await signScraperIdentity('bob') };
    assert.equal((await fetch(base + `/api/scrapers/${endpoint.id}`, { headers: bob })).status, 404);
    const detail = await fetch(base + `/api/scrapers/${endpoint.id}`, { headers: alice }); assert.equal(detail.status, 200);
    assert.equal((await detail.json()).spec.openapi, '3.0.3');
    assert.equal((await fetch(base + `/api/scrapers/${endpoint.id}`, { headers: { ...alice, 'x-relay-scraper-identity': 'forged' } })).status, 401);
    assert.equal((await fetch(base + `/api/v1/custom/${endpoint.id}`)).status, 401);
    const unrelated = store.createKey('Unrelated key', ['tools:read'], 60);
    assert.equal((await fetch(base + `/api/v1/custom/${endpoint.id}`, { headers: { 'X-API-Key': unrelated.secret } })).status, 403);
    const reveal = await fetch(base + `/api/scrapers/jobs/${job.id}/reveal`, { method: 'POST', headers: alice });
    assert.equal(reveal.status, 200);
    assert.equal((await fetch(base + `/api/scrapers/jobs/${job.id}/reveal`, { method: 'POST', headers: alice })).status, 410);
    const stream = await fetch(base + `/api/scrapers/jobs/${job.id}/events`, { headers: alice });
    assert.equal(stream.headers.get('content-type')?.split(';')[0], 'text/event-stream');
    const events = await stream.text(); assert.match(events, /event: log/); assert.match(events, /event: done/);
    const listing = await fetch(base + '/api/inspector', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools = (await listing.json()).result.tools as { name: string }[];
    assert(tools.some(tool => tool.name === store.getEndpoint(endpoint.id)?.name));
    scraperStore.delete(endpoint.id, 'alice'); store.revokeKey(unrelated.key.id);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
