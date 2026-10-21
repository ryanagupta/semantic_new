import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../errors.js';

export type Tier = 'free' | 'pro' | 'enterprise';
function enterpriseQuota(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}
export const plans = {
  free: { monthly: 10000, requests: 60, tools: 10 },
  pro: { monthly: 1000000, requests: 1000, tools: 200 },
  enterprise: {
    monthly: enterpriseQuota('ENTERPRISE_MONTHLY_CREDITS', 10000000),
    requests: enterpriseQuota('ENTERPRISE_REQUESTS_PER_MINUTE', 10000),
    tools: enterpriseQuota('ENTERPRISE_TOOLS_PER_MINUTE', 2000),
  },
};
export interface BillingSnapshot {
  tier: Tier; monthlyLimit: number; used: number; credits: number; remaining: number;
  maxRateLimit: number; toolRateLimit: number; periodStart: string; periodEnd: string;
  subscriptionId: string | null; configured: boolean;
}
type Row = Record<string, string | number | null>;
export interface BillingEvent { type: string; timestamp: string; data: Record<string, unknown>; }
export interface PendingOrder { id: string; email: string; productId: string; quantity: number; sessionId: string | null; checkoutUrl: string | null; createdAt: string; }

export class BillingStore {
  readonly db: DatabaseSync;
  private inTransaction = false;

  constructor(path = config.databasePath) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS billing_workspace(id TEXT PRIMARY KEY,tier TEXT NOT NULL,monthly_limit INTEGER NOT NULL,used INTEGER NOT NULL,credits INTEGER NOT NULL,period_start TEXT NOT NULL,period_end TEXT NOT NULL,subscription_id TEXT,last_event_time TEXT NOT NULL,terminal INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,subscription_order_id TEXT);
      CREATE TABLE IF NOT EXISTS billing_orders(id TEXT PRIMARY KEY,plan TEXT NOT NULL,product_id TEXT NOT NULL,quantity INTEGER NOT NULL,email TEXT NOT NULL,session_id TEXT,created_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',checkout_url TEXT);
      CREATE TABLE IF NOT EXISTS billing_events(id TEXT PRIMARY KEY,type TEXT NOT NULL,processed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_fulfillments(id TEXT PRIMARY KEY,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quota_notifications(id TEXT PRIMARY KEY,payload TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,sent_at TEXT);
      CREATE TABLE IF NOT EXISTS quota_ledger(id TEXT PRIMARY KEY,cost INTEGER NOT NULL,created_at TEXT NOT NULL);`);
    const workspaceColumns = this.db.prepare('PRAGMA table_info(billing_workspace)').all() as Row[];
    if (!workspaceColumns.some(column => column.name === 'subscription_order_id')) this.db.exec('ALTER TABLE billing_workspace ADD COLUMN subscription_order_id TEXT');
    const orderColumns = this.db.prepare('PRAGMA table_info(billing_orders)').all() as Row[];
    if (!orderColumns.some(column => column.name === 'status')) this.db.exec("ALTER TABLE billing_orders ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
    if (!orderColumns.some(column => column.name === 'checkout_url')) this.db.exec('ALTER TABLE billing_orders ADD COLUMN checkout_url TEXT');
    const now = new Date(), end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    this.db.prepare("INSERT OR IGNORE INTO billing_workspace(id,tier,monthly_limit,used,credits,period_start,period_end,subscription_id,last_event_time,terminal,version) VALUES('default','free',10000,0,0,?,?,NULL,'',0,0)").run(now.toISOString(), end.toISOString());
  }

  transaction<T>(operation: () => T): T {
    if (this.inTransaction) return operation();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }

  private workspace(): Row { return this.db.prepare("SELECT * FROM billing_workspace WHERE id='default'").get() as Row; }
  private revokePaidKeys() {
    this.db.prepare('UPDATE api_keys SET revoked_at=? WHERE rate_limit>? AND revoked_at IS NULL').run(new Date().toISOString(), plans.free.requests);
  }
  private beginFreePeriod(row: Row) {
    const now = new Date(), end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    this.db.prepare("UPDATE billing_workspace SET tier='free',monthly_limit=?,credits=MAX(0,credits-MAX(0,used-monthly_limit)),used=0,period_start=?,period_end=?,version=version+1 WHERE id='default'").run(plans.free.monthly, now.toISOString(), end.toISOString());
    if (row.tier !== 'free') this.revokePaidKeys();
  }

  snapshot(): BillingSnapshot {
    return this.transaction(() => {
      let row = this.workspace();
      if (Date.parse(String(row.period_end)) <= Date.now()) { this.beginFreePeriod(row); row = this.workspace(); }
      const tier = row.tier as Tier, plan = plans[tier];
      return {
        tier, monthlyLimit: Number(row.monthly_limit), used: Number(row.used), credits: Number(row.credits),
        remaining: Math.max(0, Number(row.monthly_limit) + Number(row.credits) - Number(row.used)),
        maxRateLimit: plan.requests, toolRateLimit: plan.tools,
        periodStart: String(row.period_start), periodEnd: String(row.period_end), subscriptionId: row.subscription_id as string | null,
        configured: !!(process.env.DODO_PAYMENTS_API_KEY && process.env.DODO_PAYMENTS_WEBHOOK_KEY && process.env.DODO_PRO_PRODUCT_ID && process.env.DODO_CREDITS_PRODUCT_ID && config.REDIS_URL),
      };
    });
  }

  consume(cost: number, id = randomUUID()): BillingSnapshot {
    if (!Number.isSafeInteger(cost) || cost < 1) throw new Error('Invalid credit cost');
    return this.transaction(() => {
      const current = this.snapshot();
      if (this.db.prepare('SELECT id FROM quota_ledger WHERE id=?').get(id)) return current;
      if (current.remaining < cost) throw new HttpError(402, 'Monthly usage limit reached. Please upgrade your plan or purchase add-on credits.');
      this.db.prepare("UPDATE billing_workspace SET used=used+?,version=version+1 WHERE id='default'").run(cost);
      this.db.prepare('INSERT INTO quota_ledger VALUES(?,?,?)').run(id, cost, new Date().toISOString());
      const next = this.snapshot(), allowance = next.monthlyLimit + next.credits;
      if (next.used >= allowance * .8) {
        const notificationId = `quota80:${next.periodStart}`;
        this.db.prepare('INSERT OR IGNORE INTO quota_notifications(id,payload) VALUES(?,?)').run(notificationId, JSON.stringify({ event: 'quota.warning', workspace: 'default', threshold: 80, tier: next.tier, used: next.used, allowance, periodStart: next.periodStart }));
      }
      return next;
    });
  }

  createOrder(plan: 'pro' | 'credits', productId: string, quantity: number, email: string) {
    return this.transaction(() => {
      if (plan === 'pro') {
        if (this.snapshot().tier !== 'free') throw new HttpError(409, 'This workspace already has an active paid subscription');
        if (this.db.prepare("SELECT id FROM billing_orders WHERE plan='pro' AND status='pending' LIMIT 1").get()) throw new HttpError(409, 'A Pro checkout is already pending. Complete the existing checkout before creating another.');
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO billing_orders(id,plan,product_id,quantity,email,session_id,created_at,status) VALUES(?,?,?,?,?,NULL,?,'pending')").run(id, plan, productId, quantity, email, new Date().toISOString());
      return id;
    });
  }
  getPendingOrder(): PendingOrder | undefined {
    const row = this.db.prepare("SELECT * FROM billing_orders WHERE plan='pro' AND status='pending' ORDER BY created_at LIMIT 1").get() as Row | undefined;
    return row ? { id: String(row.id), email: String(row.email), productId: String(row.product_id), quantity: Number(row.quantity), sessionId: row.session_id as string | null, checkoutUrl: row.checkout_url as string | null, createdAt: String(row.created_at) } : undefined;
  }
  bindSession(id: string, sessionId: string, checkoutUrl?: string) { this.db.prepare('UPDATE billing_orders SET session_id=?,checkout_url=COALESCE(?,checkout_url) WHERE id=?').run(sessionId, checkoutUrl ?? null, id); }
  failOrder(id: string) { this.db.prepare("UPDATE billing_orders SET status='failed' WHERE id=? AND status='pending' AND session_id IS NULL").run(id); }
  processed(id: string) { return !!this.db.prepare('SELECT id FROM billing_events WHERE id=?').get(id); }

  fulfill(webhookId: string, event: BillingEvent) {
    return this.transaction(() => {
      if (this.processed(webhookId)) return 'duplicate';
      const data = event.data, metadata = (data.metadata ?? {}) as Record<string, unknown>;
      const orderId = typeof metadata.nexus_order_id === 'string' ? metadata.nexus_order_id : '';
      const order = this.db.prepare('SELECT * FROM billing_orders WHERE id=?').get(orderId) as Row | undefined;
      const now = new Date().toISOString();
      const supported = ['payment.succeeded', 'subscription.active', 'subscription.renewed', 'subscription.cancelled', 'subscription.expired'];
      if (!supported.includes(event.type)) { this.recordEvent(webhookId, event.type); return 'ignored'; }
      if (!order) throw new HttpError(422, 'Webhook does not reference a server-created order');
      const customer = data.customer as Record<string, unknown> | undefined;
      if (customer?.email && String(customer.email).toLowerCase() !== String(order.email).toLowerCase()) throw new HttpError(422, 'Webhook customer does not match order');
      const fulfillOnce = (id: string, operation: () => void) => {
        if (!this.db.prepare('SELECT id FROM billing_fulfillments WHERE id=?').get(id)) {
          operation(); this.db.prepare('INSERT INTO billing_fulfillments VALUES(?,?)').run(id, now);
        }
      };
      if (event.type === 'payment.succeeded' && order.plan === 'credits') {
        const cart = data.product_cart;
        if (!Array.isArray(cart) || cart.length !== 1 || cart[0]?.product_id !== order.product_id || cart[0]?.quantity !== order.quantity || typeof data.payment_id !== 'string' || data.status !== 'succeeded') throw new HttpError(422, 'Payment product, quantity, or status does not match order');
        if (!order.session_id || data.checkout_session_id !== order.session_id) throw new HttpError(422, 'Payment checkout session does not match order');
        fulfillOnce(`payment:${data.payment_id}`, () => this.db.prepare("UPDATE billing_workspace SET credits=credits+?,version=version+1 WHERE id='default'").run(Number(order.quantity) * 10000));
        this.db.prepare("UPDATE billing_orders SET status='completed' WHERE id=?").run(orderId);
      } else if (event.type.startsWith('subscription.') && order.plan === 'pro') {
        if (data.product_id !== order.product_id || typeof data.subscription_id !== 'string') throw new HttpError(422, 'Subscription product does not match order');
        const row = this.workspace(), subscriptionId = data.subscription_id;
        const eventTime = Date.parse(event.timestamp);
        if (!Number.isFinite(eventTime)) throw new HttpError(422, 'Invalid subscription event timestamp');
        const timestamp = new Date(eventTime).toISOString();
        const same = row.subscription_id === subscriptionId;
        const terminal = event.type === 'subscription.cancelled' || event.type === 'subscription.expired';
        if (same && eventTime < Date.parse(String(row.last_event_time))) { this.recordEvent(webhookId, event.type); return 'stale'; }
        if (!same && row.subscription_id) {
          if (terminal) { this.recordEvent(webhookId, event.type); return 'stale'; }
          const currentOrder = row.subscription_order_id ? this.db.prepare('SELECT created_at FROM billing_orders WHERE id=?').get(row.subscription_order_id) as Row | undefined : undefined;
          const cutoff = Date.parse(String(currentOrder?.created_at ?? row.period_start));
          if (Date.parse(String(order.created_at)) <= cutoff) { this.recordEvent(webhookId, event.type); return 'stale'; }
        }
        if (terminal) {
          if (row.tier !== 'free') this.beginFreePeriod(row);
          this.db.prepare("UPDATE billing_workspace SET tier='free',monthly_limit=?,subscription_id=?,subscription_order_id=?,last_event_time=?,terminal=1,version=version+1 WHERE id='default'").run(plans.free.monthly, subscriptionId, orderId, timestamp);
          this.revokePaidKeys();
          this.db.prepare("UPDATE billing_orders SET status='completed' WHERE id=?").run(orderId);
        } else if (!(same && row.terminal)) {
          if (data.status !== 'active') throw new HttpError(422, 'Subscription is not active');
          const startTime = typeof data.previous_billing_date === 'string' ? Date.parse(data.previous_billing_date) : NaN;
          const endTime = typeof data.next_billing_date === 'string' ? Date.parse(data.next_billing_date) : NaN;
          if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= Date.now() || startTime >= endTime) throw new HttpError(422, 'Invalid subscription billing period');
          const start = new Date(startTime).toISOString(), end = new Date(endTime).toISOString();
          if (same && endTime < Date.parse(String(row.period_end))) { this.recordEvent(webhookId, event.type); return 'stale'; }
          fulfillOnce(`period:${subscriptionId}:${end}`, () => {
            this.db.prepare("UPDATE billing_workspace SET tier='pro',monthly_limit=?,credits=MAX(0,credits-MAX(0,used-monthly_limit)),used=0,period_start=?,period_end=?,subscription_id=?,subscription_order_id=?,terminal=0,version=version+1 WHERE id='default'").run(plans.pro.monthly, start, end, subscriptionId, orderId);
          });
          // Even a repeated period carries fresh ordering information, without replenishing its allowance.
          this.db.prepare("UPDATE billing_workspace SET last_event_time=?,version=version+1 WHERE id='default'").run(timestamp);
          this.db.prepare("UPDATE billing_orders SET status='completed' WHERE id=?").run(orderId);
        }
      }
      this.recordEvent(webhookId, event.type); return 'processed';
    });
  }
  private recordEvent(id: string, type: string) { this.db.prepare('INSERT INTO billing_events VALUES(?,?,?)').run(id, type, new Date().toISOString()); }
  notifications() { return this.db.prepare('SELECT id,payload,attempts FROM quota_notifications WHERE sent_at IS NULL AND attempts<10 LIMIT 10').all() as Row[]; }
  notificationAttempt(id: string, sent: boolean) { this.db.prepare('UPDATE quota_notifications SET attempts=attempts+1,sent_at=? WHERE id=?').run(sent ? new Date().toISOString() : null, id); }
  close() { this.db.close(); }
}
export const billingStore = new BillingStore();
