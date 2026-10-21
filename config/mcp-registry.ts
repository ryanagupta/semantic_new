export type ProviderId = 'reactbits' | 'sequential-thinking' | 'mobbin' | 'higgsfield';
export type ProviderCategory = 'Design' | 'Thinking' | 'Media Gen';
export interface McpProvider {
  id: ProviderId; name: string; category: ProviderCategory; description: string; requiresOAuth: boolean;
  configured: boolean; authConfigured: boolean; transport: 'streamable-http' | 'sse';
  mcpUrl?: string;
  oauth?: { authorizationUrl: string; tokenUrl: string; clientId: string; clientSecret?: string; scope: string; clientAuthMethod: 'client_secret_basic' | 'client_secret_post' | 'none' };
}

export const MCP_REGISTRY = [
  { id: 'reactbits', name: 'ReactBits', category: 'Design', description: 'Connect your configured ReactBits MCP service.', requiresOAuth: false, env: 'REACTBITS' },
  { id: 'sequential-thinking', name: 'Sequential Thinking', category: 'Thinking', description: 'Connect your configured Sequential Thinking MCP service.', requiresOAuth: false, env: 'SEQUENTIAL_THINKING' },
  { id: 'mobbin', name: 'Mobbin', category: 'Design', description: 'Connect an authorized Mobbin MCP integration.', requiresOAuth: true, env: 'MOBBIN' },
  { id: 'higgsfield', name: 'Higgsfield', category: 'Media Gen', description: 'Connect an authorized Higgsfield MCP integration.', requiresOAuth: true, env: 'HIGGSFIELD' },
] as const;

function httpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : undefined; } catch { return undefined; }
}

export function getProvider(id: string): McpProvider {
  const entry = MCP_REGISTRY.find(item => item.id === id);
  if (!entry) throw new Error('Unknown MCP provider.');
  const prefix = entry.env;
  const mcpUrl = httpsUrl(process.env[`${prefix}_MCP_URL`]);
  const authorizationUrl = httpsUrl(process.env[`${prefix}_OAUTH_AUTHORIZATION_URL`]);
  const tokenUrl = httpsUrl(process.env[`${prefix}_OAUTH_TOKEN_URL`]);
  const clientId = process.env[`${prefix}_OAUTH_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`${prefix}_OAUTH_CLIENT_SECRET`]?.trim();
  const method = process.env[`${prefix}_OAUTH_CLIENT_AUTH_METHOD`] ?? (clientSecret ? 'client_secret_basic' : 'none');
  const validMethod = ['client_secret_basic', 'client_secret_post', 'none'].includes(method) && (method === 'none' || Boolean(clientSecret));
  const authConfigured = Boolean(authorizationUrl && tokenUrl && clientId && validMethod);
  return {
    id: entry.id, name: entry.name, category: entry.category, description: entry.description, requiresOAuth: entry.requiresOAuth,
    mcpUrl, configured: Boolean(mcpUrl) && (!entry.requiresOAuth || authConfigured), authConfigured,
    transport: process.env[`${prefix}_MCP_TRANSPORT`] === 'sse' ? 'sse' : 'streamable-http',
    ...(authConfigured ? { oauth: { authorizationUrl: authorizationUrl!, tokenUrl: tokenUrl!, clientId: clientId!, clientSecret, scope: process.env[`${prefix}_OAUTH_SCOPE`] ?? '', clientAuthMethod: method as NonNullable<McpProvider['oauth']>['clientAuthMethod'] } } : {}),
  };
}

/** Public descriptors never contain remote URLs, client credentials, or access tokens. */
export function listProviders() {
  return MCP_REGISTRY.map(entry => {
    const { mcpUrl: _url, oauth: _oauth, ...descriptor } = getProvider(entry.id);
    return descriptor;
  });
}
