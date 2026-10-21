import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { checkoutSchema, verifyDodoWebhook } from '../server/billing/dodo.js';
import { HttpError } from '../server/errors.js';
import { withQuotaLock } from '../server/middleware/quotas.js';
import { SlidingWindowLimiter, RateLimitError } from '../server/limiter.js';

const secretBytes = randomBytes(32);
const signingKey = 'whsec_' + secretBytes.toString('base64');
const now = Date.now();
const raw = Buffer.from(JSON.stringify({ type: 'payment.succeeded', timestamp: new Date(now).toISOString(), business_id: 'business_test', data: { payment_id: 'payment_001' } }));
function signedHeaders(body = raw, seconds = Math.floor(now / 1000)) {
  const id = 'webhook_test', timestamp = String(seconds);
  const signature = createHmac('sha256', secretBytes).update(`${id}.${timestamp}.`).update(body).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
}
const unauthorized = (error: unknown) => error instanceof HttpError && error.status === 401;

test('Standard Webhooks signature verifies exact raw bytes and supports multiple versioned signatures', () => {
  const headers = signedHeaders();
  assert.equal(verifyDodoWebhook(raw, headers, signingKey, now).type, 'payment.succeeded');
  assert.equal(verifyDodoWebhook(raw, { ...headers, 'webhook-signature': `v0,ignored v1,${randomBytes(32).toString('base64')} ${headers['webhook-signature']}` }, signingKey, now).type, 'payment.succeeded');
  assert.throws(() => verifyDodoWebhook(Buffer.from(raw.toString().replace('payment_001', 'payment_attacker')), headers, signingKey, now), unauthorized);
  assert.throws(() => verifyDodoWebhook(Buffer.from(raw.toString() + ' '), headers, signingKey, now), unauthorized);
  assert.throws(() => verifyDodoWebhook(raw, { ...headers, 'webhook-id': 'another_id' }, signingKey, now), unauthorized);
});

test('Webhook verification rejects old/future deliveries, missing headers and malformed signatures', () => {
  for (const offset of [-301, 301]) assert.throws(() => verifyDodoWebhook(raw, signedHeaders(raw, Math.floor(now / 1000) + offset), signingKey, now), unauthorized);
  assert.throws(() => verifyDodoWebhook(raw, {}, signingKey, now), unauthorized);
  for (const signature of ['v1,invalid!', 'v2,abcd', 'v1,AA==', 'v1,']) assert.throws(() => verifyDodoWebhook(raw, { ...signedHeaders(), 'webhook-signature': signature }, signingKey, now), unauthorized);
  assert.throws(() => verifyDodoWebhook(raw, { ...signedHeaders(), 'webhook-timestamp': 'NaN' }, signingKey, now), unauthorized);
});

test('Webhook business binding and secret configuration fail closed', t => {
  const prior = process.env.DODO_BUSINESS_ID;
  t.after(() => { if (prior === undefined) delete process.env.DODO_BUSINESS_ID; else process.env.DODO_BUSINESS_ID = prior; });
  process.env.DODO_BUSINESS_ID = 'different_business';
  assert.throws(() => verifyDodoWebhook(raw, signedHeaders(), signingKey, now), unauthorized);
  process.env.DODO_BUSINESS_ID = 'business_test';
  assert.equal(verifyDodoWebhook(raw, signedHeaders(), signingKey, now).type, 'payment.succeeded');
  assert.throws(() => verifyDodoWebhook(raw, signedHeaders(), 'whsec_c2hvcnQ=', now), (error: unknown) => error instanceof HttpError && error.status === 503);
});

test('Checkout input constrains products, quantity, customer information and unexpected properties', () => {
  const input = { plan: 'pro', quantity: 1, email: 'developer@example.com', name: 'Developer', billingAddress: { country: 'GB', zipcode: 'SW1A 1AA', street: '1 Example Street', city: 'London', state: 'London' } };
  assert.equal(checkoutSchema.parse(input).quantity, 1);
  const invalid = [ { ...input, plan: 'enterprise' }, { ...input, quantity: 2 }, { ...input, plan: 'credits', quantity: 101 }, { ...input, plan: 'credits', quantity: -1 }, { ...input, quantity: 1.5 }, { ...input, email: 'not-an-email' }, { ...input, product_id: 'cheaper_product' }, { ...input, billingAddress: { ...input.billingAddress, country: 'gb' } } ];
  for (const request of invalid) assert.equal(checkoutSchema.safeParse(request).success, false);
});

test('Quota mutation lock serializes concurrent mutations and releases after a failed operation', async () => {
  let active = 0, maxActive = 0, completed = 0;
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, index) => withQuotaLock(async () => {
    active++; maxActive = Math.max(maxActive, active);
    try { await new Promise(resolve => setTimeout(resolve, 1)); if (index === 5) throw new Error('expected failure'); completed++; }
    finally { active--; }
  })));
  assert.equal(maxActive, 1); assert.equal(completed, 29);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(await withQuotaLock(() => 42), 42);
});

test('Concurrent memory-rate requests cannot pass the sliding-window allowance', async () => {
  const limiter = new SlidingWindowLimiter();
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => limiter.consume('one-key', 10)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 10);
  for (const result of results) if (result.status === 'rejected') {
    assert.ok(result.reason instanceof RateLimitError);
    assert.equal(result.reason.rate.limit, 10); assert.equal(result.reason.rate.remaining, 0);
  }
  assert.equal((await limiter.consume('another-key', 10)).remaining, 9);
});
