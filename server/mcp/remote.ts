import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { MCP_REGISTRY, type McpProvider } from '../../config/mcp-registry.js';
import type { Endpoint, Principal } from '../../shared/types.js';
import { getProviderAccessToken } from '../oauth/service.js';
import { configuredProvider, createPinnedFetch, providerActor, providerChallenge } from './proxy-guard.js';
import { sanitizeArguments } from './guardrails.js';
import { consumeToolRate,rateHeaders } from '../middleware/security.js';
import { requestContext } from '../execution.js';
import { consumeQuota } from '../middleware/quotas.js';
import { HttpError } from '../errors.js';
import { assertCircuitAvailable, acquireCircuit, type CircuitCompletion } from '../gateway/circuit-breaker.js';
import { store } from '../store.js';
import { maskText } from '../telemetry/logger.js';

function authorized(principal: Principal, name: string, call: boolean): boolean {
  return principal.scopes.some(scope => ['*', 'admin', 'tools:*', 'tools:call', ...(call ? [] : ['tools:read']), `tool:${name}`].includes(scope));
}
async function access(provider: McpProvider, principal: Principal) {
  return provider.requiresOAuth ? getProviderAccessToken(provider.id, providerActor(principal)) : undefined;
}
async function withClient<T>(provider: McpProvider, token: string | undefined, operation: (client: Client) => Promise<T>, externalIdentity=false): Promise<T> {
  const pinned = createPinnedFetch(provider.mcpUrl!, token);
  const client = new Client({ name: 'nexusmcp-provider-bridge', version: '1.0.0' });
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const transport = provider.transport === 'sse'
    ? new SSEClientTransport(new URL(provider.mcpUrl!), { fetch: pinned.fetch, requestInit: { headers, redirect: 'manual' }, eventSourceInit: { fetch: pinned.fetch } })
    : new StreamableHTTPClientTransport(new URL(provider.mcpUrl!), { fetch: pinned.fetch, requestInit: { headers, redirect: 'manual' }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
  try { await client.connect(transport, { timeout: 5000 }); return await operation(client); }
  catch (error) {
    if (provider.requiresOAuth && ((error as { code?: number })?.code === 401 || /\b401\b|unauthorized/i.test(error instanceof Error ? error.message : ''))) throw providerChallenge(provider.id,externalIdentity);
    throw error;
  } finally { await client.close(); await pinned.close(); }
}

async function tools(client: Client): Promise<Tool[]> {
  const output: Tool[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 5000 });
    output.push(...page.tools);
    if (output.length > 500) throw new HttpError(502, 'Provider exposes too many tools (maximum 500).');
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new HttpError(502, 'Provider returned a repeated pagination cursor.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return output;
}

/** A disconnected paid provider exposes a consent action, never an anonymously forwarded call. */
export async function listRemoteTools(principal: Principal): Promise<Tool[]> {
  if (!principal.scopes.some(scope => ['*','admin','tools:*','tools:call','tools:read'].includes(scope) || scope.startsWith('tool:'))) return [];
  const pages = await Promise.allSettled(MCP_REGISTRY.map(async entry => {
    let provider: McpProvider;
    try { provider = configuredProvider(entry.id); } catch { return []; }
    let token: string | undefined;
    try { token = await access(provider, principal); }
    catch (error) {
      if ((error as { code?: number })?.code === -32001) {
        const name = `${provider.id}__connect`;
        return authorized(principal, name, false) ? [{ name, description: `Connect ${provider.name} with your own provider account. Invoking this action returns a secure authorization URL.`, inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false } }] : [];
      }
      return [];
    }
    return withClient(provider, token, async client => (await tools(client)).map(tool => ({ ...tool, name: `${provider.id}__${tool.name}`, description: `[${provider.name}] ${tool.description ?? tool.name}` })).filter(tool => authorized(principal, tool.name, false)),principal.id.startsWith('jwt:'));
  }));
  return pages.flatMap(page => page.status === 'fulfilled' ? page.value : []);
}

export async function callRemoteTool(providerId: string, toolName: string, args: Record<string, unknown>, principal: Principal): Promise<CallToolResult> {
  const provider = configuredProvider(providerId);
  const name = `${provider.id}__${toolName}`;
  if (!authorized(principal, name, true)) throw new HttpError(403, 'API key does not have permission for this remote tool.');
  if (principal.id !== 'dashboard' && !principal.id.startsWith('jwt:') && !store.isKeyActive(principal.id)) throw new HttpError(401, 'API key revoked.');
  // Authorization is resolved before connecting, rate debits, quota debits, or upstream calls.
  const token = await access(provider, principal);
  const circuitId = `provider:${provider.id}`;
  assertCircuitAvailable(circuitId);
  const started = performance.now();
  let status = 500, errorMessage: string | null = null;
  let record: CircuitCompletion | undefined;
  let dispatched = false;
  try {
    return await withClient(provider, token, async client => {
      const tool = (await tools(client)).find(item => item.name === toolName);
      if (!tool) throw new HttpError(404, 'Remote tool does not exist.');
      const endpoint: Endpoint = { id: circuitId, name, description: tool.description ?? name, method: 'POST', url: provider.mcpUrl!, enabled: true, inputSchema: tool.inputSchema, parameters: Object.keys(tool.inputSchema.properties ?? {}).map(property => ({ name: property, in: 'query' as const })), createdAt: '', updatedAt: '' };
      let clean:Record<string,unknown>;
      try{clean=sanitizeArguments(endpoint,args);}catch(error){throw new HttpError(400,error instanceof Error?error.message:'Invalid remote tool arguments.');}
      record = acquireCircuit(circuitId);
      const rate=await consumeToolRate(principal);
      const context=requestContext.getStore();
      if(context&&!context.response.headersSent)rateHeaders(context.response,rate);
      const quota=await consumeQuota();
      if(context&&!context.response.headersSent&&quota.used>=(quota.monthlyLimit+quota.credits)*.8)context.response.setHeader('X-Nexus-Quota-Warning','80%');
      dispatched = true;
      const result = CallToolResultSchema.parse(await client.callTool({ name: toolName, arguments: clean }, CallToolResultSchema, { timeout: 5000 }));
      status = result.isError ? 502 : 200;
      record(Boolean(result.isError));
      return result;
    },principal.id.startsWith('jwt:'));
  } catch (error) {
    status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 502;
    record?.(dispatched ? status >= 500 : null);
    errorMessage = maskText(error instanceof Error ? error.message : 'Remote MCP call failed.');
    throw error;
  } finally { store.log({ endpointId: null, tool: name, method: 'MCP', status, latency: performance.now() - started, tokens: 0, keyId: principal.id, error: errorMessage }); }
}
