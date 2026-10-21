import test from 'node:test';
import assert from 'node:assert/strict';
import { BillingStore, type BillingEvent } from '../server/billing/store.js';
import { HttpError } from '../server/errors.js';

const email = 'developer@example.com';
const future = () => new Date(Date.now() + 30 * 86400000).toISOString();
const before = (milliseconds = 60000) => new Date(Date.now() - milliseconds).toISOString();

function memoryStore(t: { after: (callback: () => void) => void }) {
  const store = new BillingStore(':memory:');
  store.db.exec('CREATE TABLE api_keys (id TEXT PRIMARY KEY, rate_limit INTEGER NOT NULL, revoked_at TEXT)');
  t.after(() => store.close());
  return store;
}
function subscription(store: BillingStore, options: { timestamp?: string; end?: string; start?: string; subscriptionId?: string } = {}) {
  const order = store.createOrder('pro', 'pro_product', 1, email);
  store.bindSession(order, 'checkout_pro');
  const event: BillingEvent = { type: 'subscription.active', timestamp: options.timestamp ?? before(), data: {
    metadata: { nexus_order_id: order, nexus_workspace_id: 'default' },
    customer: { email }, product_id: 'pro_product', subscription_id: options.subscriptionId ?? 'sub_001',
    status: 'active', previous_billing_date: options.start ?? before(3600000), next_billing_date: options.end ?? future(),
  } };
  return event;
}
function creditPayment(store: BillingStore, quantity = 2): BillingEvent {
  const order = store.createOrder('credits', 'credits_product', quantity, email);
  store.bindSession(order, 'checkout_credits');
  return { type: 'payment.succeeded', timestamp: new Date().toISOString(), data: {
    metadata: { nexus_order_id: order, nexus_workspace_id: 'default' }, customer: { email },
    product_cart: [{ product_id: 'credits_product', quantity }],
    payment_id: 'payment_001', status: 'succeeded', checkout_session_id: 'checkout_credits',
  } };
}

test('Credit fulfillment is idempotent across webhook redelivery and distinct event IDs for one payment', t => {
  const store = memoryStore(t), event = creditPayment(store);
  assert.equal(store.fulfill('event_1', event), 'processed');
  assert.equal(store.snapshot().credits, 20000);
  assert.equal(store.fulfill('event_1', event), 'duplicate');
  assert.equal(store.fulfill('event_2', event), 'processed');
  assert.equal(store.snapshot().credits, 20000);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM billing_fulfillments').get()?.count, 1);
});

test('Credit fulfillment binds payment product, quantity, checkout session and customer to the server order', t => {
  const store = memoryStore(t), event = creditPayment(store);
  const changes = [
    { checkout_session_id: 'another_checkout' },
    { product_cart: [{ product_id: 'another_product', quantity: 2 }] },
    { product_cart: [{ product_id: 'credits_product', quantity: 100 }] },
    { customer: { email: 'someone-else@example.com' } },
    { status: 'processing' },
    { metadata: { nexus_order_id: 'unknown_order' } },
  ];
  for (const [index, change] of changes.entries()) {
    assert.throws(() => store.fulfill(`invalid_${index}`, { ...event, data: { ...event.data, ...change } }), (error: unknown) => error instanceof HttpError && error.status === 422);
    assert.equal(store.snapshot().credits, 0);
    assert.equal(store.processed(`invalid_${index}`), false);
  }
});

test('Quota debits are atomic at the allowance boundary and idempotent by request ID', t => {
  const store = memoryStore(t);
  store.db.prepare("UPDATE billing_workspace SET monthly_limit=2 WHERE id='default'").run();
  assert.equal(store.consume(1, 'request_1').remaining, 1);
  assert.equal(store.consume(1, 'request_1').remaining, 1);
  assert.equal(store.consume(1, 'request_2').remaining, 0);
  assert.throws(() => store.consume(1, 'request_3'), (error: unknown) => error instanceof HttpError && error.status === 402);
  assert.equal(store.snapshot().used, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM quota_ledger').get()?.count, 2);
  for (const cost of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => store.consume(cost), /Invalid credit cost/);
});

test('Free period rollover preserves only unused add-on credits and resets once', t => {
  const store = memoryStore(t);
  store.db.prepare("UPDATE billing_workspace SET used=12500,credits=10000,period_end=? WHERE id='default'").run(before());
  const next = store.snapshot();
  assert.equal(next.credits, 7500);
  assert.equal(next.used, 0);
  assert.equal(next.remaining, 17500);
  assert.ok(Date.parse(next.periodEnd) > Date.now());
  assert.deepEqual(store.snapshot(), next);
});

test('80 percent quota notification is persisted once per period', t => {
  const store = memoryStore(t);
  store.db.prepare("UPDATE billing_workspace SET monthly_limit=10 WHERE id='default'").run();
  store.consume(7, 'request_7'); assert.equal(store.notifications().length, 0);
  store.consume(1, 'request_8'); store.consume(1, 'request_9');
  assert.equal(store.notifications().length, 1);
  const notification = store.notifications()[0];
  assert.equal(JSON.parse(String(notification.payload)).threshold, 80);
  store.notificationAttempt(String(notification.id), false);
  assert.equal(store.notifications()[0].attempts, 1);
  store.notificationAttempt(String(notification.id), true);
  assert.equal(store.notifications().length, 0);
});

test('A second delivery for the same subscription period never replenishes consumed credits', t => {
  const store = memoryStore(t), event = subscription(store);
  store.fulfill('activation', event); store.consume(120, 'tools');
  store.fulfill('same_period', { ...event, timestamp: new Date().toISOString() });
  assert.equal(store.snapshot().tier, 'pro');
  assert.equal(store.snapshot().used, 120);
});

test('Cancellation revokes above-Free keys and delayed activation cannot restore a terminal subscription', t => {
  const store = memoryStore(t), event = subscription(store);
  store.db.exec("INSERT INTO api_keys VALUES('free_key',60,NULL),('pro_key',1000,NULL)");
  store.fulfill('activation', event);
  store.fulfill('cancellation', { ...event, type: 'subscription.cancelled', timestamp: new Date().toISOString(), data: { ...event.data, status: 'cancelled' } });
  assert.equal(store.snapshot().tier, 'free');
  assert.equal(store.db.prepare("SELECT revoked_at FROM api_keys WHERE id='free_key'").get()?.revoked_at, null);
  assert.ok(store.db.prepare("SELECT revoked_at FROM api_keys WHERE id='pro_key'").get()?.revoked_at);
  store.fulfill('delayed_activation', event);
  assert.equal(store.snapshot().tier, 'free');
});

test('Expired paid periods roll into a usable Free allowance rather than retaining historical Pro usage', t => {
  const store = memoryStore(t);
  store.db.prepare("UPDATE billing_workspace SET tier='pro',monthly_limit=1000000,used=500000,period_end=?,subscription_id='expired_sub' WHERE id='default'").run(before());
  const next = store.snapshot();
  assert.equal(next.tier, 'free');
  assert.equal(next.used, 0);
  assert.equal(next.remaining, 10000);
  assert.ok(Date.parse(next.periodEnd) > Date.now());
  assert.equal(store.consume(1, 'first_free_request').remaining, 9999);
});

test('Same-period newer events advance ordering without replenishing quota, so older cancellation stays stale', t => {
  const store = memoryStore(t), event = subscription(store, { timestamp: before(180000) });
  store.fulfill('activation', event); store.consume(50, 'tools');
  store.fulfill('newer_active', { ...event, timestamp: before(60000) });
  store.fulfill('older_cancel', { ...event, type: 'subscription.cancelled', timestamp: before(120000), data: { ...event.data, status: 'cancelled' } });
  assert.equal(store.snapshot().tier, 'pro');
  assert.equal(store.snapshot().used, 50);
});

test('Event ordering compares instants rather than ISO text with different timezone offsets', t => {
  const store = memoryStore(t), event = subscription(store, { timestamp: before(60000) });
  store.fulfill('activation', event);
  const oldInstant = Date.now() - 120000;
  const offsetTimestamp = new Date(oldInstant + 7200000).toISOString().replace('Z', '+02:00');
  store.fulfill('offset_stale_cancel', { ...event, type: 'subscription.cancelled', timestamp: offsetTimestamp, data: { ...event.data, status: 'cancelled' } });
  assert.equal(store.snapshot().tier, 'pro');
});

test('Subscription activation rejects an invalid billing-period start', t => {
  const store = memoryStore(t), event = subscription(store, { start: 'not-a-date' });
  assert.throws(() => store.fulfill('invalid_period', event), (error: unknown) => error instanceof HttpError && error.status === 422);
  assert.equal(store.snapshot().tier, 'free');
  assert.equal(store.processed('invalid_period'), false);
});

test('A pending Pro checkout is unique and its saved session can be resumed', t => {
  const store = memoryStore(t);
  const id = store.createOrder('pro', 'pro_product', 1, email);
  assert.throws(() => store.createOrder('pro', 'pro_product', 1, email), (error: unknown) => error instanceof HttpError && error.status === 409);
  store.bindSession(id, 'checkout_resume', 'https://checkout.dodopayments.com/session_resume');
  assert.equal(store.getPendingOrder()?.id, id);
  assert.equal(store.getPendingOrder()?.checkoutUrl, 'https://checkout.dodopayments.com/session_resume');
  store.failOrder(id);
  assert.equal(store.getPendingOrder()?.id, id, 'A live checkout must not be released by a local error.');
});

test('A failed unbound checkout can be retried without leaving the workspace locked', t => {
  const store = memoryStore(t);
  const id = store.createOrder('pro', 'pro_product', 1, email);
  store.failOrder(id);
  assert.equal(store.getPendingOrder(), undefined);
  assert.notEqual(store.createOrder('pro', 'pro_product', 1, email), id);
});

test('Paid expiry settles used add-on credits once and revokes elevated keys', t => {
  const store = memoryStore(t);
  store.db.exec("INSERT INTO api_keys VALUES('pro_key',1000,NULL)");
  store.db.prepare("UPDATE billing_workspace SET tier='pro',monthly_limit=1000000,used=1004000,credits=10000,period_end=? WHERE id='default'").run(before());
  const next = store.snapshot();
  assert.equal(next.credits, 6000); assert.equal(next.remaining, 16000); assert.equal(next.used, 0);
  assert.ok(store.db.prepare("SELECT revoked_at FROM api_keys WHERE id='pro_key'").get()?.revoked_at);
  assert.deepEqual(store.snapshot(), next);
});
