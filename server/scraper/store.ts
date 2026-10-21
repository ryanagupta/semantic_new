import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { store } from '../store.js';
import { HttpError } from '../errors.js';
import type { CreateScraperInput } from './settings.js';
import type { OutputSchema } from './schema.js';

export interface ScraperEndpoint {
  id: string; ownerId: string; name: string; description: string; targetUrl: string;
  cacheTtlSeconds: number; enabled: boolean; createdAt: string; keyId: string;
  code: string; sample: unknown; schema: OutputSchema;
}
export interface ScraperJob {
  id: string; ownerId: string; status: 'queued' | 'running' | 'succeeded' | 'failed';
  input: CreateScraperInput; endpointId: string | null; error: string | null;
  createdAt: string; lease: string | null; attempts: number;
}
export interface ScraperEvent { id: string; message: string; time: string; }
type Row = Record<string, string | number | null>;

export class ScraperStore {
  private db: DatabaseSync;
  constructor(path = config.databasePath) {
    // Importing the gateway store initializes endpoints/api_keys before these FKs.
    void store;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS scraper_endpoints(
        id TEXT PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
        name TEXT NOT NULL, description TEXT NOT NULL, target_url TEXT NOT NULL, cache_ttl INTEGER NOT NULL,
        enabled INTEGER NOT NULL, created_at TEXT NOT NULL, key_id TEXT NOT NULL,
        artifact TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS scraper_owner ON scraper_endpoints(owner_id,created_at);
      CREATE TABLE IF NOT EXISTS scraper_jobs(
        id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,status TEXT NOT NULL,input TEXT NOT NULL,
        endpoint_id TEXT,error TEXT,created_at TEXT NOT NULL,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,reveal TEXT,reveal_until INTEGER);
      CREATE INDEX IF NOT EXISTS scraper_jobs_queue ON scraper_jobs(status,lease_until,created_at);
      CREATE TABLE IF NOT EXISTS scraper_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES scraper_jobs(id) ON DELETE CASCADE,
        message TEXT NOT NULL,time TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS scraper_events_job ON scraper_events(job_id,seq);`);
  }
  private seal(value: unknown) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'hex'), iv);
    const content = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${content.toString('base64')}`;
  }
  private open<T>(value: string): T {
    const [iv, tag, content] = value.split(':');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'hex'), Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(content, 'base64')), decipher.final()]).toString()) as T;
  }
  private endpoint(row: Row): ScraperEndpoint {
    return { id: String(row.id), ownerId: String(row.owner_id), name: String(row.name), description: String(row.description),
      targetUrl: String(row.target_url), cacheTtlSeconds: Number(row.cache_ttl), enabled: !!row.enabled,
      createdAt: String(row.created_at), keyId: String(row.key_id), ...this.open<Pick<ScraperEndpoint, 'code' | 'sample' | 'schema'>>(String(row.artifact)) };
  }
  get(id: string, ownerId?: string) {
    const row = this.db.prepare(`SELECT * FROM scraper_endpoints WHERE id=?${ownerId ? ' AND owner_id=?' : ''}`).get(...(ownerId ? [id, ownerId] : [id])) as Row | undefined;
    return row ? this.endpoint(row) : undefined;
  }
  list(ownerId: string) { return (this.db.prepare('SELECT * FROM scraper_endpoints WHERE owner_id=? ORDER BY created_at DESC').all(ownerId) as Row[]).map(row => this.endpoint(row)); }
  private job(row: Row): ScraperJob {
    return { id: String(row.id), ownerId: String(row.owner_id), status: row.status as ScraperJob['status'],
      input: this.open<CreateScraperInput>(String(row.input)), endpointId: row.endpoint_id as string | null,
      error: row.error as string | null, createdAt: String(row.created_at), lease: row.lease as string | null, attempts: Number(row.attempts) };
  }
  getJob(id: string, ownerId?: string) {
    const row = this.db.prepare(`SELECT * FROM scraper_jobs WHERE id=?${ownerId ? ' AND owner_id=?' : ''}`).get(...(ownerId ? [id, ownerId] : [id])) as Row | undefined;
    return row ? this.job(row) : undefined;
  }
  createJob(ownerId: string, input: CreateScraperInput) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db.prepare("SELECT COUNT(*) count FROM scraper_jobs WHERE owner_id=? AND status IN ('queued','running')").get(ownerId) as Row;
      const queued = this.db.prepare("SELECT COUNT(*) count FROM scraper_jobs WHERE status IN ('queued','running')").get() as Row;
      if (Number(active.count) >= 2 || Number(queued.count) >= 20) throw new HttpError(429, 'The scraper queue is full. Wait for an active build to finish.');
      const count = this.db.prepare('SELECT COUNT(*) count FROM endpoints').get() as Row;
      if (Number(count.count) >= 500) throw new HttpError(409, 'Relay endpoint limit reached (500).');
      const id = randomUUID(), now = new Date().toISOString();
      this.db.prepare("INSERT INTO scraper_jobs(id,owner_id,status,input,created_at) VALUES(?,?,'queued',?,?)").run(id, ownerId, this.seal(input), now);
      this.db.exec('COMMIT');
      this.log(id, 'Queued. Waiting for an agent worker.');
      return this.getJob(id)!;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  claim(): ScraperJob | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE scraper_jobs SET status='failed',error='Build stopped after repeated worker restarts.',lease=NULL WHERE status='running' AND lease_until<? AND attempts>=3").run(Date.now());
      const row = this.db.prepare("SELECT * FROM scraper_jobs WHERE status='queued' OR (status='running' AND lease_until<? AND attempts<3) ORDER BY created_at LIMIT 1").get(Date.now()) as Row | undefined;
      if (!row) { this.db.exec('COMMIT'); return; }
      const lease = randomUUID();
      this.db.prepare("UPDATE scraper_jobs SET status='running',lease=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(lease, Date.now() + 30000, row.id);
      this.db.exec('COMMIT'); return this.getJob(String(row.id));
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  heartbeat(job: ScraperJob) { return this.db.prepare("UPDATE scraper_jobs SET lease_until=? WHERE id=? AND lease=? AND status='running'").run(Date.now() + 30000, job.id, job.lease).changes > 0; }
  fail(job: ScraperJob, error: string) {
    const updated = this.db.prepare("UPDATE scraper_jobs SET status='failed',error=?,lease=NULL WHERE id=? AND lease=? AND status='running'").run(error.slice(0, 1000), job.id, job.lease).changes;
    if (updated) this.log(job.id, error);
  }
  log(id: string, message: string) {
    const time = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO scraper_events(job_id,message,time) VALUES(?,?,?)').run(id, message.slice(0, 2000), time);
    return { id: String(result.lastInsertRowid), message, time };
  }
  events(jobId: string, after = 0): ScraperEvent[] {
    return (this.db.prepare('SELECT seq,message,time FROM scraper_events WHERE job_id=? AND seq>? ORDER BY seq LIMIT 100').all(jobId, after) as Row[])
      .map(row => ({ id: String(row.seq), message: String(row.message), time: String(row.time) }));
  }
  complete(job: ScraperJob, artifact: { name: string; description: string; code: string; sample: unknown; schema: OutputSchema }, rateLimit: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getJob(job.id);
      if (current?.lease !== job.lease || current.status !== 'running') throw new HttpError(409, 'Build lease expired.');
      const endpointCount = this.db.prepare('SELECT COUNT(*) count FROM endpoints').get() as Row;
      const keyCount = this.db.prepare('SELECT COUNT(*) count FROM api_keys WHERE revoked_at IS NULL').get() as Row;
      if (Number(endpointCount.count) >= 500) throw new HttpError(409, 'Relay endpoint limit reached (500).');
      if (Number(keyCount.count) >= 100) throw new HttpError(409, 'Active API key limit reached (100). Revoke an unused key before rebuilding.');
      const id = job.id, toolName = `scrape_${id.replaceAll('-', '').slice(0, 20)}`, keyId = randomUUID(), now = new Date().toISOString();
      const secret = `nx_live_${randomBytes(32).toString('base64url')}`;
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'hex'), iv);
      const empty = Buffer.concat([cipher.update('{}'), cipher.final()]);
      const headers = [iv.toString('hex'), cipher.getAuthTag().toString('hex'), empty.toString('hex')].join(':');
      this.db.prepare('INSERT INTO endpoints VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, toolName, artifact.description, 'GET', job.input.targetUrl, 1, JSON.stringify({ type: 'object', properties: {}, additionalProperties: false }), '[]', null, headers, 'rest', now, now);
      this.db.prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?,NULL,NULL)').run(keyId, `${artifact.name} · scraper`, secret.slice(0, 16), createHash('sha256').update(secret).digest('hex'), JSON.stringify([`tool:${toolName}`, 'tools:read']), rateLimit, now);
      this.db.prepare('INSERT INTO scraper_endpoints VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, job.ownerId, artifact.name, artifact.description, job.input.targetUrl, job.input.cacheTtlSeconds, 1, now, keyId, this.seal({ code: artifact.code, sample: artifact.sample, schema: artifact.schema }));
      this.db.prepare("UPDATE scraper_jobs SET status='succeeded',endpoint_id=?,lease=NULL,reveal=?,reveal_until=? WHERE id=?").run(id, this.seal(secret), Date.now() + 3600000, job.id);
      this.log(job.id, 'Endpoint live. API docs and a scoped Relay key are ready.');
      this.db.exec('COMMIT'); return this.get(id)!;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  reveal(jobId: string, ownerId: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT reveal,reveal_until FROM scraper_jobs WHERE id=? AND owner_id=? AND status='succeeded'").get(jobId, ownerId) as Row | undefined;
      if (!row?.reveal || Number(row.reveal_until) < Date.now()) throw new HttpError(410, 'The key was already revealed or expired. Create a replacement in API keys.');
      const secret = this.open<string>(String(row.reveal));
      this.db.prepare('UPDATE scraper_jobs SET reveal=NULL,reveal_until=NULL WHERE id=? AND owner_id=?').run(jobId, ownerId);
      this.db.exec('COMMIT'); return secret;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  setEnabled(id: string, ownerId: string, enabled: boolean) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('UPDATE scraper_endpoints SET enabled=? WHERE id=? AND owner_id=?').run(+enabled, id, ownerId).changes) throw new HttpError(404, 'Scraper not found.');
      this.db.prepare('UPDATE endpoints SET enabled=?,updated_at=? WHERE id=?').run(+enabled, new Date().toISOString(), id);
      this.db.exec('COMMIT'); return this.get(id, ownerId)!;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  delete(id: string, ownerId: string) {
    const endpoint = this.get(id, ownerId); if (!endpoint) throw new HttpError(404, 'Scraper not found.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(new Date().toISOString(), endpoint.keyId);
      this.db.prepare('DELETE FROM endpoints WHERE id=?').run(id);
      this.db.prepare('DELETE FROM scraper_jobs WHERE endpoint_id=? AND owner_id=?').run(id, ownerId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  prune() {
    this.db.prepare('UPDATE scraper_jobs SET reveal=NULL,reveal_until=NULL WHERE reveal_until<?').run(Date.now());
    this.db.prepare("DELETE FROM scraper_jobs WHERE status IN ('failed','succeeded') AND created_at<?").run(new Date(Date.now() - 7 * 86400000).toISOString());
  }
  close() { this.db.close(); }
}
export const scraperStore = new ScraperStore();
