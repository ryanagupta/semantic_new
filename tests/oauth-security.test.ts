import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { OAuthService } from '../server/oauth/service.js';
import { TokenVault, type OAuthStorage } from '../server/oauth/store.js';
import { createPinnedFetch } from '../server/mcp/proxy-guard.js';
import { getProvider, listProviders, type McpProvider } from '../config/mcp-registry.js';
import { HttpError } from '../server/errors.js';
import { callRemoteTool } from '../server/mcp/remote.js';
import { limiter } from '../server/limiter.js';
import { billingStore } from '../server/billing/store.js';

class MemoryStorage implements OAuthStorage {
  readonly values = new Map<string, string>();
  readonly locks = new Map<string, string>();
  onGet?: (key: string, snapshot: string | null) => Promise<void>;
  onCompareExchange?: (key: string) => Promise<void>;
  async get(key: string) { const snapshot = this.values.get(key) ?? null; await this.onGet?.(key, snapshot); return snapshot; }
  async put(key: string, value: string) { this.values.set(key, value); }
  async take(key: string) { const value = this.values.get(key) ?? null; this.values.delete(key); return value; }
  async remove(key: string) { this.values.delete(key); }
  async compareExchange(key: string, expected: string | null, replacement: string | null, _ttlSeconds: number) {
    await this.onCompareExchange?.(key);
    if ((this.values.get(key) ?? null) !== expected) return false;
    if (replacement === null) this.values.delete(key); else this.values.set(key, replacement);
    return true;
  }
  async lock(key: string, owner: string) { if (this.locks.has(key)) return false; this.locks.set(key, owner); return true; }
  async unlock(key: string, owner: string) { if (this.locks.get(key) === owner) this.locks.delete(key); }
}
const provider: McpProvider = {
  id: 'mobbin', name: 'Mobbin', category: 'Design', description: 'Test integration', requiresOAuth: true,
  configured: true, authConfigured: true, transport: 'streamable-http', mcpUrl: 'https://provider.example/mcp',
  oauth: { authorizationUrl: 'https://provider.example/authorize', tokenUrl: 'https://provider.example/token', clientId: 'test_client', scope: 'read', clientAuthMethod: 'none' },
};
const expiredTokens = { accessToken: 'expired_access', refreshToken: 'refresh_secret', expiresAt: Date.now() - 1000, tokenType: 'Bearer' as const };

test('Encrypted token envelopes cannot be transplanted between users or providers', async () => {
  const storage = new MemoryStorage(), vault = new TokenVault(storage, randomBytes(32));
  await vault.set('owner_a', 'mobbin', { ...expiredTokens, expiresAt: Date.now() + 3600000 });
  const encrypted = storage.values.get(vault.keyFor('owner_a', 'mobbin'))!;
  assert.ok(!encrypted.includes('expired_access')); assert.ok(!encrypted.includes('refresh_secret'));
  storage.values.set(vault.keyFor('owner_b', 'mobbin'), encrypted);
  storage.values.set(vault.keyFor('owner_a', 'higgsfield'), encrypted);
  await assert.rejects(vault.get('owner_b', 'mobbin'), /unreadable/);
  await assert.rejects(vault.get('owner_a', 'higgsfield'), /unreadable/);
  assert.equal((await vault.get('owner_a', 'mobbin'))?.accessToken, 'expired_access');
});

test('Pinned provider fetch rejects cross-origin, credential-bearing and private destinations before connecting', async () => {
  const pinned = createPinnedFetch('https://provider.example/mcp', 'never_forward_this_token');
  try {
    for (const url of ['https://attacker.example/mcp', 'http://provider.example/mcp', 'https://provider.example:8443/mcp', 'https://user:password@provider.example/mcp', 'https://provider.example/mcp#fragment']) await assert.rejects(pinned.fetch(url), /cannot change/);
  } finally { await pinned.close(); }
  const privateFetch = createPinnedFetch('https://127.0.0.1/mcp', 'never_forward_this_token');
  try { await assert.rejects(privateFetch.fetch('https://127.0.0.1/mcp'), /private|non-public/i); }
  finally { await privateFetch.close(); }
});

test('Registry public descriptors never reveal provider URLs or OAuth client secrets', t => {
  const names = ['MOBBIN_MCP_URL', 'MOBBIN_OAUTH_AUTHORIZATION_URL', 'MOBBIN_OAUTH_TOKEN_URL', 'MOBBIN_OAUTH_CLIENT_ID', 'MOBBIN_OAUTH_CLIENT_SECRET'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
  Object.assign(process.env, { MOBBIN_MCP_URL: 'https://provider.example/mcp', MOBBIN_OAUTH_AUTHORIZATION_URL: 'https://provider.example/authorize', MOBBIN_OAUTH_TOKEN_URL: 'https://provider.example/token', MOBBIN_OAUTH_CLIENT_ID: 'client_private', MOBBIN_OAUTH_CLIENT_SECRET: 'secret_private' });
  assert.equal(getProvider('mobbin').configured, true);
  const publicJson = JSON.stringify(listProviders());
  for (const value of ['provider.example', 'client_private', 'secret_private', 'authorizationUrl', 'tokenUrl', 'mcpUrl']) assert.ok(!publicJson.includes(value), value);
});

test('Disconnect wins when a refresh races between its final token read and its commit', async () => {
  const storage = new MemoryStorage();
  const service = new OAuthService(storage, async () => ({ access_token: 'refreshed_access', token_type: 'Bearer', expires_in: 3600 }), () => provider, randomBytes(32), async () => {});
  await service.vault.set('owner', 'mobbin', expiredTokens);
  let disconnected = false;
  const tokenKey = service.vault.keyFor('owner', 'mobbin');
  storage.onCompareExchange = async key => {
    if (key === tokenKey) { storage.onCompareExchange = undefined; disconnected = true; await service.disconnect('mobbin', 'owner'); }
  };
  await service.accessToken('mobbin', 'owner').catch(() => undefined);
  assert.equal(disconnected, true);
  assert.equal(await service.vault.get('owner', 'mobbin'), null);
});

test('A rejected stale refresh cannot erase a token installed by a new connection', async () => {
  const storage = new MemoryStorage();
  let rejectExchange!: (error: unknown) => void, signalStarted!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const exchange = new Promise<never>((_resolve, reject) => { rejectExchange = reject; });
  const service = new OAuthService(storage, async () => { signalStarted(); return exchange; }, () => provider, randomBytes(32), async () => {});
  await service.vault.set('owner', 'mobbin', expiredTokens);
  const refresh = service.accessToken('mobbin', 'owner');
  await started;
  await service.vault.set('owner', 'mobbin', { accessToken: 'new_connection_access', refreshToken: 'new_connection_refresh', expiresAt: Date.now() + 3600000, tokenType: 'Bearer' });
  rejectExchange(new HttpError(401, 'Old grant revoked'));
  await refresh.catch(() => undefined);
  assert.equal((await service.vault.get('owner', 'mobbin'))?.accessToken, 'new_connection_access');
});

test('Missing provider authorization rejects before upstream connection or quota debit', async t => {
  const names = ['MOBBIN_MCP_URL', 'MOBBIN_OAUTH_AUTHORIZATION_URL', 'MOBBIN_OAUTH_TOKEN_URL', 'MOBBIN_OAUTH_CLIENT_ID', 'MOBBIN_OAUTH_CLIENT_AUTH_METHOD'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const clientDescriptor = Object.getOwnPropertyDescriptor(limiter, 'client');
  t.after(() => {
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    if (clientDescriptor) Object.defineProperty(limiter, 'client', clientDescriptor); else Reflect.deleteProperty(limiter, 'client');
  });
  Object.assign(process.env, { MOBBIN_MCP_URL: 'https://provider.example/mcp', MOBBIN_OAUTH_AUTHORIZATION_URL: 'https://provider.example/authorize', MOBBIN_OAUTH_TOKEN_URL: 'https://provider.example/token', MOBBIN_OAUTH_CLIENT_ID: 'client_test', MOBBIN_OAUTH_CLIENT_AUTH_METHOD: 'none' });
  let lookups = 0;
  Object.defineProperty(limiter, 'client', { configurable: true, get: () => ({ isReady: true, get: async () => { lookups++; return null; } }) });
  const debit = t.mock.method(billingStore, 'consume', () => { throw new Error('Unauthorized requests must not consume quota.'); });
  await assert.rejects(callRemoteTool('mobbin', 'render', {}, { id: 'dashboard', scopes: ['tools:call'], rateLimit: 60 }), (error: unknown) => (error as { code?: number })?.code === -32001);
  assert.equal(lookups, 1);
  assert.equal(debit.mock.callCount(), 0);
  await assert.rejects(callRemoteTool('mobbin', 'render', {}, { id: 'dashboard', scopes: ['tools:read'], rateLimit: 60 }), (error: unknown) => error instanceof HttpError && error.status === 403);
  assert.equal(lookups, 1, 'Scope rejection must happen before loading owner tokens.');
});
