import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ApiKey, Endpoint, EndpointInput, Metrics, Principal, RequestLog } from '../shared/types.js';
import { config } from './config.js';

type Row = Record<string, string | number | null>;
export class Store {
  private db: DatabaseSync;
  constructor(path = config.databasePath) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS endpoints(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL,method TEXT NOT NULL,url TEXT NOT NULL,enabled INTEGER NOT NULL,input_schema TEXT NOT NULL,parameters TEXT NOT NULL,body_property TEXT,encrypted_headers TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,name TEXT NOT NULL,prefix TEXT NOT NULL,secret_hash TEXT NOT NULL UNIQUE,scopes TEXT NOT NULL,rate_limit INTEGER NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT,revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS request_logs(id TEXT PRIMARY KEY,timestamp TEXT NOT NULL,endpoint_id TEXT,tool TEXT NOT NULL,method TEXT NOT NULL,status INTEGER NOT NULL,latency REAL NOT NULL,tokens INTEGER NOT NULL DEFAULT 0,key_id TEXT,error TEXT);
      CREATE INDEX IF NOT EXISTS request_logs_time ON request_logs(timestamp);`);
  }
  private encrypt(value: unknown) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(config.encryptionKey,'hex'),iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'), cipher.final()]);
    return [iv.toString('hex'),cipher.getAuthTag().toString('hex'),data.toString('hex')].join(':');
  }
  private decrypt(value: string): Record<string,string> {
    const [iv,tag,data]=value.split(':');
    const cipher=createDecipheriv('aes-256-gcm',Buffer.from(config.encryptionKey,'hex'),Buffer.from(iv,'hex'));
    cipher.setAuthTag(Buffer.from(tag,'hex'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data,'hex')),cipher.final()]).toString('utf8'));
  }
  private endpoint(row: Row): Endpoint {
    return {id:String(row.id), name:String(row.name),description:String(row.description),method:row.method as Endpoint['method'],url:String(row.url),enabled:!!row.enabled,inputSchema:JSON.parse(String(row.input_schema)),parameters:JSON.parse(String(row.parameters)),bodyProperty:row.body_property ? String(row.body_property):undefined,headers:this.decrypt(String(row.encrypted_headers)),kind:row.kind as Endpoint['kind'],createdAt:String(row.created_at),updatedAt:String(row.updated_at)};
  }
  listEndpoints(): Endpoint[] { return (this.db.prepare('SELECT * FROM endpoints ORDER BY created_at DESC').all() as Row[]).map(r=>this.endpoint(r)); }
  getEndpoint(id: string): Endpoint | undefined { const row=this.db.prepare('SELECT * FROM endpoints WHERE id=?').get(id) as Row|undefined; return row ? this.endpoint(row):undefined; }
  saveEndpoint(input: EndpointInput, id: string = randomUUID()): Endpoint {
    const old=this.getEndpoint(id), now=new Date().toISOString();
    this.db.prepare(`INSERT INTO endpoints VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,method=excluded.method,url=excluded.url,enabled=excluded.enabled,input_schema=excluded.input_schema,parameters=excluded.parameters,body_property=excluded.body_property,encrypted_headers=excluded.encrypted_headers,kind=excluded.kind,updated_at=excluded.updated_at`).run(id,input.name,input.description,input.method,input.url,+input.enabled,JSON.stringify(input.inputSchema),JSON.stringify(input.parameters),input.bodyProperty??null,this.encrypt(input.headers??{}),input.kind??'rest',old?.createdAt??now,now);
    return this.getEndpoint(id)!;
  }
  importEndpoints(inputs: EndpointInput[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const endpoints=inputs.map(e=>this.saveEndpoint(e)); this.db.exec('COMMIT'); return endpoints; }
    catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  deleteEndpoint(id: string) { return this.db.prepare('DELETE FROM endpoints WHERE id=?').run(id).changes>0; }
  private key(row: Row): ApiKey { return {id:String(row.id),name:String(row.name),prefix:String(row.prefix),scopes:JSON.parse(String(row.scopes)),rateLimit:Number(row.rate_limit),createdAt:String(row.created_at),lastUsedAt:row.last_used_at as string|null,revokedAt:row.revoked_at as string|null}; }
  listKeys(): ApiKey[] { return (this.db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as Row[]).map(r=>this.key(r)); }
  createKey(name: string, scopes: string[], rateLimit: number) {
    const secret=`nx_live_${randomBytes(32).toString('base64url')}`, id=randomUUID(), now=new Date().toISOString();
    this.db.prepare('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?,NULL,NULL)').run(id,name,secret.slice(0,16),createHash('sha256').update(secret).digest('hex'),JSON.stringify(scopes),rateLimit,now);
    return {key:this.listKeys().find(k=>k.id===id)!,secret};
  }
  authenticateKey(secret: string): Principal | undefined {
    const row=this.db.prepare('SELECT * FROM api_keys WHERE secret_hash=? AND revoked_at IS NULL').get(createHash('sha256').update(secret).digest('hex')) as Row|undefined;
    if(!row) return;
    this.db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(new Date().toISOString(),row.id);
    return {id:String(row.id),scopes:JSON.parse(String(row.scopes)),rateLimit:Number(row.rate_limit),rateKey:String(row.secret_hash)};
  }
  isKeyActive(id: string) { return !!this.db.prepare('SELECT id FROM api_keys WHERE id=? AND revoked_at IS NULL').get(id); }
  revokeKey(id: string) { return this.db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(new Date().toISOString(),id).changes>0; }
  log(input: Omit<RequestLog,'id'|'timestamp'>) {
    this.db.prepare('INSERT INTO request_logs VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),new Date().toISOString(),input.endpointId,input.tool,input.method,input.status,input.latency,input.tokens,input.keyId,input.error);
  }
  pruneLogs() { this.db.prepare('DELETE FROM request_logs WHERE timestamp < ?').run(new Date(Date.now()-30*86400000).toISOString()); }
  metrics(hours: number): Metrics {
    const since=new Date(Date.now()-hours*3600000).toISOString();
    const summary=this.db.prepare('SELECT COUNT(*) total,AVG(latency) latency,SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) errors,SUM(tokens) tokens FROM request_logs WHERE timestamp>=?').get(since) as Row;
    const total=Number(summary.total), offset=Math.max(0,Math.ceil(total*.95)-1);
    const p95=this.db.prepare('SELECT latency FROM request_logs WHERE timestamp>=? ORDER BY latency LIMIT 1 OFFSET ?').get(since,offset) as Row|undefined;
    const bucketMs=hours*3600000/24;
    const grouped=this.db.prepare('SELECT CAST((julianday(timestamp)-2440587.5)*86400000 / ? AS INTEGER) bucket,COUNT(*) requests,AVG(latency) latency,SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) errors,SUM(tokens) tokens FROM request_logs WHERE timestamp>=? GROUP BY bucket').all(bucketMs,since) as Row[];
    const endBucket=Math.floor(Date.now()/bucketMs);
    const series=Array.from({length:24},(_,i)=>{ const bucket=endBucket-23+i,r=grouped.find(x=>Number(x.bucket)===bucket); return {time:new Date(bucket*bucketMs).toISOString(),requests:Number(r?.requests??0),latency:Number(r?.latency??0),errors:Number(r?.errors??0),tokens:Number(r?.tokens??0)}; });
    const recent=(this.db.prepare('SELECT * FROM request_logs WHERE timestamp>=? ORDER BY timestamp DESC LIMIT 20').all(since) as Row[]).map(r=>({id:String(r.id),timestamp:String(r.timestamp),endpointId:r.endpoint_id as string|null,tool:String(r.tool),method:String(r.method),status:Number(r.status),latency:Number(r.latency),tokens:Number(r.tokens),keyId:r.key_id as string|null,error:r.error as string|null}));
    return {totalRequests:total,averageLatency:Number(summary.latency??0),p95Latency:Number(p95?.latency??0),errorRate:total?Number(summary.errors)/total*100:0,activeKeys:this.listKeys().filter(k=>!k.revokedAt).length,totalTokens:Number(summary.tokens??0),endpoints:this.listEndpoints().filter(e=>e.enabled).length,series,recent};
  }
  close(){this.db.close();}
}
export const store = new Store();
