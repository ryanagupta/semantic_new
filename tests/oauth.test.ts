import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OAuthService } from '../server/oauth/service.js';
import { TokenVault, type OAuthStorage } from '../server/oauth/store.js';
import { providerActor, providerChallenge, createPinnedFetch } from '../server/mcp/proxy-guard.js';
import { listProviders, getProvider, type McpProvider } from '../config/mcp-registry.js';
import { createMcpServer } from '../server/bridge/mcp.js';

class MemoryOAuthStorage implements OAuthStorage {
  values = new Map<string, { value: string; expires: number }>();
  async get(key: string) { const entry = this.values.get(key); if (!entry || entry.expires <= Date.now()) { this.values.delete(key); return null; } return entry.value; }
  async put(key: string, value: string, ttlSeconds: number) { this.values.set(key, { value, expires: Date.now() + ttlSeconds * 1000 }); }
  async take(key: string) { const value = await this.get(key); this.values.delete(key); return value; }
  async remove(key: string) { this.values.delete(key); }
  async lock(key: string, owner: string, ttlSeconds: number) { if (await this.get(key)) return false; await this.put(key, owner, ttlSeconds); return true; }
  async unlock(key: string, owner: string) { if (await this.get(key) === owner) await this.remove(key); }
  async compareExchange(key: string, expected: string | null, replacement: string | null, ttl: number) {
    if (await this.get(key) !== expected) return false;
    if (replacement === null) await this.remove(key); else await this.put(key, replacement, ttl);
    return true;
  }
}
const encryptionKey = Buffer.alloc(32, 7);
const provider: McpProvider = { id: 'mobbin', name: 'Mobbin', category: 'Design', description: 'Test provider fixture', requiresOAuth: true, configured: true, authConfigured: true, transport: 'streamable-http', mcpUrl: 'https://mcp.provider.example/mcp', oauth: { authorizationUrl: 'https://auth.provider.example/authorize', tokenUrl: 'https://auth.provider.example/token', clientId: 'fixture-client', clientSecret: 'fixture-secret', scope: 'tools:read tools:call', clientAuthMethod: 'client_secret_basic' } };
const service = (storage: MemoryOAuthStorage, exchange: ConstructorParameters<typeof OAuthService>[1]) => new OAuthService(storage, exchange, () => provider, encryptionKey, async () => undefined);

test('Provider registry is configuration-driven and public descriptors contain no credentials', () => {
  const names = ['MOBBIN_MCP_URL', 'MOBBIN_OAUTH_AUTHORIZATION_URL', 'MOBBIN_OAUTH_TOKEN_URL', 'MOBBIN_OAUTH_CLIENT_ID', 'MOBBIN_OAUTH_CLIENT_SECRET'];
  const previous = names.map(name => process.env[name]);
  try {
    names.forEach(name => delete process.env[name]);
    assert.equal(getProvider('mobbin').configured, false);
    Object.assign(process.env, { MOBBIN_MCP_URL: provider.mcpUrl, MOBBIN_OAUTH_AUTHORIZATION_URL: provider.oauth!.authorizationUrl, MOBBIN_OAUTH_TOKEN_URL: provider.oauth!.tokenUrl, MOBBIN_OAUTH_CLIENT_ID: provider.oauth!.clientId, MOBBIN_OAUTH_CLIENT_SECRET: 'never-public-secret' });
    assert.equal(getProvider('mobbin').configured, true);
    const descriptors = listProviders();
    assert.equal(descriptors.length, 4);
    assert.equal(JSON.stringify(descriptors).includes('never-public-secret'), false);
    assert.equal(JSON.stringify(descriptors).includes('auth.provider.example'), false);
    assert.deepEqual(new Set(descriptors.map(item => item.category)), new Set(['Design', 'Thinking', 'Media Gen']));
  } finally { names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }); }
});

test('OAuth state binds browser and actor, PKCE challenge matches verifier, and callback is single use', async () => {
  const storage = new MemoryOAuthStorage();
  let exchangeCount = 0;
  let exchanged: URLSearchParams | undefined;
  const oauth = service(storage, async (_provider, params) => { exchangeCount++; exchanged = params; return { access_token: 'access-fixture', refresh_token: 'refresh-fixture', token_type: 'Bearer', expires_in: 3600 }; });
  const flow = await oauth.begin('mobbin', 'workspace-owner');
  const authorization = new URL(flow.authorizationUrl);
  const state = authorization.searchParams.get('state')!;
  assert.equal(flow.cookie.options.httpOnly, true);
  assert.equal(flow.cookie.options.sameSite, 'lax');
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(oauth.complete('mobbin', { code: 'authorization-code', state }, 'wrong-browser'), /state/);
  const completed = await oauth.complete('mobbin', { code: 'authorization-code', state }, flow.cookie.value);
  assert.equal(completed.userId, 'workspace-owner');
  assert.equal(exchangeCount, 1);
  assert.equal(createHash('sha256').update(exchanged!.get('code_verifier')!).digest('base64url'), authorization.searchParams.get('code_challenge'));
  assert.equal(exchanged!.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
  assert.equal(await oauth.accessToken('mobbin', 'workspace-owner'), 'access-fixture');
  await assert.rejects(oauth.complete('mobbin', { code: 'authorization-code', state }, flow.cookie.value), /expired|already used/);
  const raw = await storage.get(oauth.vault.keyFor('workspace-owner', 'mobbin'));
  assert.ok(raw);
  assert.equal(raw.includes('access-fixture'), false);
  assert.equal(raw.includes('refresh-fixture'), false);
});

test('Encrypted token envelope rejects tampering and cross-user substitution', async () => {
  const storage = new MemoryOAuthStorage();
  const vault = new TokenVault(storage, encryptionKey);
  await vault.set('actor-one', 'mobbin', { accessToken: 'secret-token', tokenType: 'Bearer', expiresAt: Date.now() + 60000 });
  const encrypted = (await storage.get(vault.keyFor('actor-one', 'mobbin')))!;
  await storage.put(vault.keyFor('actor-two', 'mobbin'), encrypted, 60);
  await assert.rejects(vault.get('actor-two', 'mobbin'), /unreadable/);
  const corrupt = JSON.parse(encrypted); corrupt.data = Buffer.from('corruption').toString('base64');
  await storage.put(vault.keyFor('actor-one', 'mobbin'), JSON.stringify(corrupt), 60);
  await assert.rejects(vault.get('actor-one', 'mobbin'), /unreadable/);
});

test('Expired access tokens refresh once across concurrent calls and preserve rotated refresh tokens', async () => {
  const storage = new MemoryOAuthStorage();
  let exchanges = 0;
  const oauth = service(storage, async (_provider, params) => { exchanges++; assert.equal(params.get('grant_type'), 'refresh_token'); await new Promise(resolve => setTimeout(resolve, 10)); return { access_token: 'fresh-access', refresh_token: 'rotated-refresh', token_type: 'bearer', expires_in: 3600 }; });
  await oauth.vault.set('actor', 'mobbin', { accessToken: 'expired-access', refreshToken: 'original-refresh', tokenType: 'Bearer', expiresAt: Date.now() - 1 });
  const tokens = await Promise.all(Array.from({ length: 8 }, () => oauth.accessToken('mobbin', 'actor')));
  assert.deepEqual(tokens, Array(8).fill('fresh-access'));
  assert.equal(exchanges, 1);
  assert.equal((await oauth.vault.get('actor', 'mobbin'))?.refreshToken, 'rotated-refresh');
});

test('Disconnect during refresh cannot restore provider credentials', async () => {
  const storage = new MemoryOAuthStorage();
  let release!: () => void;
  let started!: () => void;
  const exchangeStarted = new Promise<void>(resolve => { started = resolve; });
  const oauth = service(storage, async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return { access_token: 'late-access', refresh_token: 'late-refresh', token_type: 'Bearer', expires_in: 3600 }; });
  await oauth.vault.set('actor', 'mobbin', { accessToken: 'expired', refreshToken: 'refresh', tokenType: 'Bearer', expiresAt: 1 });
  const refreshing = oauth.accessToken('mobbin', 'actor');
  await exchangeStarted;
  await oauth.disconnect('mobbin', 'actor');
  release();
  await assert.rejects(refreshing, error => (error as { code?: number }).code === -32001);
  assert.equal(await oauth.vault.get('actor', 'mobbin'), null);
});

test('Missing credentials produce the exact MCP challenge with a safe consent URL', async () => {
  const oauth = service(new MemoryOAuthStorage(), async () => { throw new Error('Must never contact provider without credentials.'); });
  await assert.rejects(oauth.accessToken('mobbin', 'actor'), error => {
    const failure = error as { code: number; data: { auth_url: string } };
    assert.equal(failure.code, -32001);
    assert.equal(new URL(failure.data.auth_url).pathname, '/auth/connect/mobbin');
    assert.equal(new URL(failure.data.auth_url).search, '');
    return true;
  });
  assert.equal(providerActor({ id: 'api-key-id', scopes: [], rateLimit: 1 }), 'workspace-owner');
  assert.equal(providerActor({ id: 'jwt:subject', scopes: [], rateLimit: 1 }), 'jwt:subject');
});

test('Pinned provider transport rejects origin changes before any DNS or network request', async () => {
  const pinned = createPinnedFetch('https://mcp.provider.example/mcp', 'secret-not-sent');
  try { await assert.rejects(pinned.fetch('http://127.0.0.1/admin'), /configured origin/); }
  finally { await pinned.close(); }
  assert.throws(() => createPinnedFetch('http://provider.example/mcp'), /HTTPS/);
});

test('Unified official SDK server advertises provider tools and preserves OAuth challenge data', async () => {
  const principal = { id: 'dashboard', scopes: ['admin'], rateLimit: 60 };
  const server = createMcpServer({ listEndpoints: () => [], principal, execute: async () => { throw new Error('Local execution must not run.'); }, remote: { listTools: async () => [{ name: 'mobbin__connect', inputSchema: { type: 'object' } }], callTool: async providerId => { throw providerChallenge(providerId); } } });
  const client = new Client({ name: 'oauth-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    assert.equal((await client.listTools()).tools[0].name, 'mobbin__connect');
    await assert.rejects(client.callTool({ name: 'mobbin__connect', arguments: {} }), error => {
      const failure = error as { code: number; data: { auth_url: string } };
      assert.equal(failure.code, -32001);
      assert.equal(new URL(failure.data.auth_url).pathname, '/auth/connect/mobbin');
      return true;
    });
  } finally { await client.close(); await server.close(); }
});
