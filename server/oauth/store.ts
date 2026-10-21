import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { limiter } from '../limiter.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';

export interface OAuthStorage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  take(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
  lock(key: string, owner: string, ttlSeconds: number): Promise<boolean>;
  unlock(key: string, owner: string): Promise<void>;
  compareExchange(key: string, expected: string | null, replacement: string | null, ttlSeconds: number): Promise<boolean>;
}
const redis = () => { const client = limiter.client; if (!client?.isReady) throw new HttpError(503, 'Redis is required for provider authorization.'); return client; };
export const redisOAuthStorage: OAuthStorage = {
  get: key => redis().get(key),
  put: async (key, value, ttl) => { await redis().set(key, value, { EX: ttl }); },
  take: key => redis().getDel(key),
  remove: async key => { await redis().del(key); },
  lock: async (key, owner, ttl) => (await redis().set(key, owner, { NX: true, EX: ttl })) === 'OK',
  unlock: async (key, owner) => { await redis().eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", { keys: [key], arguments: [owner] }); },
  compareExchange: async (key, expected, replacement, ttl) => Number(await redis().eval("local current=redis.call('GET',KEYS[1]); if (not current and ARGV[1]=='') or current==ARGV[1] then if ARGV[2]=='' then redis.call('DEL',KEYS[1]) else redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]) end; return 1 else return 0 end", { keys: [key], arguments: [expected ?? '', replacement ?? '', String(ttl)] })) === 1,
};

export interface ProviderTokens {
  accessToken: string; refreshToken?: string; expiresAt: number; scope?: string; tokenType: 'Bearer';
}

export class TokenVault {
  constructor(private readonly storage: OAuthStorage, private readonly key: Buffer = Buffer.from(config.encryptionKey, 'hex')) {
    if (key.length !== 32) throw new Error('OAuth token encryption requires a 32-byte key.');
  }
  keyFor(userId: string, provider: string) { return `mcp_token:${encodeURIComponent(userId)}:${provider}`; }
  private encode(name: string, tokens: ProviderTokens): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(name));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
  }
  private ttl(tokens: ProviderTokens) { return tokens.refreshToken ? 90 * 86400 : Math.max(1, Math.ceil((tokens.expiresAt - Date.now()) / 1000)); }
  async set(userId: string, provider: string, tokens: ProviderTokens): Promise<void> {
    const name = this.keyFor(userId, provider);
    await this.storage.put(name, this.encode(name, tokens), this.ttl(tokens));
  }
  async get(userId: string, provider: string): Promise<ProviderTokens | null> {
    return (await this.snapshot(userId, provider))?.tokens ?? null;
  }
  async snapshot(userId: string, provider: string): Promise<{ tokens: ProviderTokens; envelope: string } | null> {
    const name = this.keyFor(userId, provider);
    const encrypted = await this.storage.get(name);
    if (!encrypted) return null;
    try {
      const envelope = JSON.parse(encrypted) as { v: number; iv: string; tag: string; data: string };
      if (envelope.v !== 1) throw new Error('Unsupported envelope.');
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(name));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return { tokens: JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')) as ProviderTokens, envelope: encrypted };
    } catch { throw new HttpError(503, 'Stored provider authorization is unreadable. Reconnect the provider.'); }
  }
  async replace(userId: string, provider: string, expectedEnvelope: string, tokens: ProviderTokens | null): Promise<boolean> {
    const name = this.keyFor(userId, provider);
    return this.storage.compareExchange(name, expectedEnvelope, tokens ? this.encode(name, tokens) : null, tokens ? this.ttl(tokens) : 1);
  }
  async remove(userId: string, provider: string): Promise<void> { await this.storage.remove(this.keyFor(userId, provider)); }
}

export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
