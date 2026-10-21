import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getProvider, MCP_REGISTRY, type McpProvider } from '../../config/mcp-registry.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { validateUpstreamUrl } from '../upstream.js';
import { createPinnedFetch, providerChallenge } from '../mcp/proxy-guard.js';
import { equalSecret, redisOAuthStorage, TokenVault, type OAuthStorage, type ProviderTokens } from './store.js';

interface AuthorizationState { provider: string; userId: string; verifier: string; redirectUri: string; createdAt: number; }
type TokenExchange = (provider: McpProvider, parameters: URLSearchParams) => Promise<unknown>;
const tokenSchema = z.object({ access_token: z.string().min(1).max(16384), token_type: z.string().refine(type => type.toLowerCase() === 'bearer', 'Only Bearer tokens are supported.'), expires_in: z.coerce.number().int().positive().max(31536000).optional(), refresh_token: z.string().min(1).max(16384).optional(), scope: z.string().max(8192).optional() });
const stateKey = (state: string) => `mcp_oauth_state:${createHash('sha256').update(state).digest('hex')}`;

async function exchangeToken(provider: McpProvider, parameters: URLSearchParams): Promise<unknown> {
  if (!provider.oauth) throw new HttpError(503, 'OAuth client configuration is missing.');
  const oauth = provider.oauth;
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (oauth.clientAuthMethod === 'client_secret_basic') headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(oauth.clientId)}:${encodeURIComponent(oauth.clientSecret!)}`).toString('base64')}`;
  else { parameters.set('client_id', oauth.clientId); if (oauth.clientAuthMethod === 'client_secret_post') parameters.set('client_secret', oauth.clientSecret!); }
  const pinned = createPinnedFetch(oauth.tokenUrl);
  try {
    const response = await pinned.fetch(oauth.tokenUrl, { method: 'POST', headers, body: parameters.toString() });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status === 400 || response.status === 401 ? 401 : 502, 'Provider token exchange failed. Reconnect the provider.'); }
    return await response.json();
  } finally { await pinned.close(); }
}

export class OAuthService {
  readonly vault: TokenVault;
  private refreshes = new Map<string, Promise<string>>();
  constructor(private readonly storage: OAuthStorage = redisOAuthStorage, private readonly exchange: TokenExchange = exchangeToken, private readonly providerLookup = getProvider, encryptionKey?: Buffer, private readonly validateUrl: (url: string) => Promise<void> = validateUpstreamUrl) {
    this.vault = new TokenVault(storage, encryptionKey);
  }
  private provider(id: string): McpProvider {
    let provider: McpProvider;
    try { provider = this.providerLookup(id); } catch { throw new HttpError(404, 'Unknown MCP provider.'); }
    if (!provider.requiresOAuth || !provider.configured || !provider.oauth) throw new HttpError(503, 'OAuth is not configured for this provider.');
    return provider;
  }
  async begin(providerId: string, userId: string) {
    const provider = this.provider(providerId);
    if (!userId || userId.length > 256) throw new HttpError(401, 'Sign in before linking a provider.');
    await Promise.all([this.validateUrl(provider.oauth!.authorizationUrl), this.validateUrl(provider.oauth!.tokenUrl)]);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const redirectUri = new URL(`/api/oauth/${provider.id}/callback`, config.APP_ORIGIN).href;
    const stored: AuthorizationState = { provider: provider.id, userId, verifier, redirectUri, createdAt: Date.now() };
    await this.storage.put(stateKey(state), JSON.stringify(stored), 600);
    const url = new URL(provider.oauth!.authorizationUrl);
    url.searchParams.set('response_type', 'code'); url.searchParams.set('client_id', provider.oauth!.clientId); url.searchParams.set('redirect_uri', redirectUri); url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url')); url.searchParams.set('code_challenge_method', 'S256');
    if (provider.oauth!.scope) url.searchParams.set('scope', provider.oauth!.scope);
    return { authorizationUrl: url.href, cookie: { name: `nexus_oauth_${provider.id}`, value: state, options: { httpOnly: true, secure: config.production, sameSite: 'lax' as const, path: `/api/oauth/${provider.id}/callback`, maxAge: 600000 } } };
  }
  async complete(providerId: string, query: { code: string; state: string }, cookieValue: string | undefined): Promise<{ userId: string; provider: string }> {
    const provider = this.provider(providerId);
    if (!cookieValue || !/^[A-Za-z0-9_-]{43}$/.test(query.state) || !equalSecret(cookieValue, query.state) || !query.code || query.code.length > 4096) throw new HttpError(400, 'OAuth state or authorization code is invalid. Start the connection again.');
    const encoded = await this.storage.take(stateKey(query.state));
    if (!encoded) throw new HttpError(400, 'OAuth state expired or was already used.');
    const state = JSON.parse(encoded) as AuthorizationState;
    if (state.provider !== provider.id || Date.now() - state.createdAt > 600000) throw new HttpError(400, 'OAuth state is invalid or expired.');
    const parameters = new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: state.redirectUri, code_verifier: state.verifier });
    const payload = tokenSchema.parse(await this.exchange(provider, parameters));
    await this.vault.set(state.userId, provider.id, this.tokens(payload));
    return { userId: state.userId, provider: provider.id };
  }
  private tokens(payload: z.infer<typeof tokenSchema>, previous?: ProviderTokens): ProviderTokens {
    return { accessToken: payload.access_token, tokenType: 'Bearer', expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000, refreshToken: payload.refresh_token ?? previous?.refreshToken, scope: payload.scope ?? previous?.scope };
  }
  async accessToken(providerId: string, userId: string): Promise<string> {
    const provider = this.provider(providerId);
    const snapshot = await this.vault.snapshot(userId, provider.id);
    const tokens = snapshot?.tokens;
    if (!tokens) throw providerChallenge(provider.id, userId.startsWith('jwt:'));
    if (tokens.expiresAt > Date.now() + 30000) return tokens.accessToken;
    if (!tokens.refreshToken) { await this.vault.replace(userId, provider.id, snapshot!.envelope, null); throw providerChallenge(provider.id, userId.startsWith('jwt:')); }
    const key = this.vault.keyFor(userId, provider.id);
    let refresh = this.refreshes.get(key);
    if (!refresh) {
      refresh = this.refresh(provider, userId, tokens).finally(() => this.refreshes.delete(key));
      this.refreshes.set(key, refresh);
    }
    return refresh;
  }
  private async refresh(provider: McpProvider, userId: string, previous: ProviderTokens): Promise<string> {
    const key = `${this.vault.keyFor(userId, provider.id)}:refresh_lock`, owner = randomUUID();
    if (!await this.storage.lock(key, owner, 10)) {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 100));
        const updated = await this.vault.get(userId, provider.id);
        if (updated && updated.accessToken !== previous.accessToken && updated.expiresAt > Date.now() + 5000) return updated.accessToken;
      }
      throw new HttpError(503, 'Provider authorization is being refreshed. Retry shortly.');
    }
    let snapshot: Awaited<ReturnType<TokenVault['snapshot']>> = null;
    try {
      snapshot = await this.vault.snapshot(userId, provider.id);
      if (!snapshot) throw providerChallenge(provider.id, userId.startsWith('jwt:'));
      const current = snapshot.tokens;
      if (current.expiresAt > Date.now() + 30000) return current.accessToken;
      const payload = tokenSchema.parse(await this.exchange(provider, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken! })));
      const updated = this.tokens(payload, current);
      if (!await this.vault.replace(userId, provider.id, snapshot.envelope, updated)) {
        const latest = await this.vault.get(userId, provider.id);
        if (latest && latest.expiresAt > Date.now() + 5000) return latest.accessToken;
        throw providerChallenge(provider.id, userId.startsWith('jwt:'));
      }
      return updated.accessToken;
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) { if (snapshot) await this.vault.replace(userId, provider.id, snapshot.envelope, null); throw providerChallenge(provider.id, userId.startsWith('jwt:')); }
      throw error;
    } finally { await this.storage.unlock(key, owner); }
  }
  async disconnect(providerId: string, userId: string) { this.provider(providerId); await this.vault.remove(userId, providerId); }
  async statuses(userId: string): Promise<Record<string, { connected: boolean; expiresAt: number | null }>> {
    const output: Record<string, { connected: boolean; expiresAt: number | null }> = {};
    for (const entry of MCP_REGISTRY) {
      if (!entry.requiresOAuth) { output[entry.id] = { connected: false, expiresAt: null }; continue; }
      let token: ProviderTokens | null = null;
      try { token = await this.vault.get(userId, entry.id); } catch { /* Unavailable storage is disconnected in the public status response. */ }
      output[entry.id] = { connected: Boolean(token && (token.expiresAt > Date.now() || token.refreshToken)), expiresAt: token?.expiresAt ?? null };
    }
    return output;
  }
}

const oauth = new OAuthService();
export const beginOAuth = (provider: string, userId: string) => oauth.begin(provider, userId);
export const completeOAuth = (provider: string, query: { code: string; state: string }, cookieValue: string | undefined) => oauth.complete(provider, query, cookieValue);
export const getProviderAccessToken = (provider: string, userId: string) => oauth.accessToken(provider, userId);
export const getOAuthStatuses = (userId: string) => oauth.statuses(userId);
export const disconnectOAuth = (provider: string, userId: string) => oauth.disconnect(provider, userId);
