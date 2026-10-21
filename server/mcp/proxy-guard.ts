import { Agent, fetch as undiciFetch } from 'undici';
import type { LookupFunction } from 'node:net';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { getProvider, type McpProvider } from '../../config/mcp-registry.js';
import type { Principal } from '../../shared/types.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { resolvePublicUpstream } from '../upstream.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

export const providerActor = (principal: Principal): string => principal.id.startsWith('jwt:') ? principal.id : 'workspace-owner';
export const providerAuthUrl = (provider: string, externalIdentity = false): string => {
  const url = new URL(`/auth/connect/${encodeURIComponent(provider)}`, config.APP_ORIGIN);
  if (externalIdentity) url.searchParams.set('identity', 'external');
  return url.href;
};
export function providerChallenge(provider: string, externalIdentity = false): McpError {
  return new McpError(-32001, 'Provider authorization required.', { auth_url: providerAuthUrl(provider, externalIdentity), provider });
}
export function configuredProvider(id: string): McpProvider {
  let provider: McpProvider;
  try { provider = getProvider(id); } catch { throw new HttpError(404, 'Unknown MCP provider.'); }
  if (!provider.configured || !provider.mcpUrl) throw new HttpError(503, 'This MCP provider has not been configured by the workspace operator.');
  return provider;
}

/** A short-lived, origin-bound fetch for SDK and OAuth traffic; DNS is pinned before each connection. */
export function createPinnedFetch(baseUrl: string, bearer?: string): { fetch: FetchLike; close: () => Promise<void> } {
  const expected = new URL(baseUrl);
  if (expected.protocol !== 'https:' || expected.username || expected.password || expected.hash) throw new HttpError(400, 'Provider endpoints require HTTPS without URL credentials.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Provider request timed out.')), 5000);
  timer.unref();
  const agents = new Set<Agent>();
  const fetcher: FetchLike = async (input, init) => {
    controller.signal.throwIfAborted();
    const target = new URL(input.toString());
    if (target.origin !== expected.origin || target.username || target.password || target.hash) throw new HttpError(403, 'Remote MCP routing cannot change the configured origin.');
    const resolved = await Promise.race([resolvePublicUpstream(target), new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Provider DNS lookup timed out.')), { once: true }))]);
    const lookup: LookupFunction = (_hostname, options, callback) => options.all ? callback(null, [{ address: resolved.address, family: resolved.family }]) : callback(null, resolved.address, resolved.family);
    const agent = new Agent({ connect: { lookup, autoSelectFamily: false, timeout: 5000 }, connections: 1, pipelining: 0 });
    agents.add(agent);
    const headers = new Headers(init?.headers);
    if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
    const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    const response = await undiciFetch(target, { ...init, headers, signal, redirect: 'manual', dispatcher: agent } as unknown as Parameters<typeof undiciFetch>[1]);
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new HttpError(502, 'Provider redirects are refused. Configure the final endpoint URL.'); }
    if (Number(response.headers.get('content-length') ?? '0') > config.MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new HttpError(502, 'Provider response exceeds the size limit.'); }
    let bytes = 0;
    const reader = response.body?.getReader();
    const stream = reader ? new ReadableStream<Uint8Array>({
      async pull(control) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { control.close(); return; }
          bytes += chunk.value.byteLength;
          if (bytes > config.MAX_RESPONSE_BYTES) { await reader.cancel(); control.error(new Error('Provider response exceeds the size limit.')); return; }
          control.enqueue(chunk.value);
        } catch (error) { control.error(error); }
      },
      async cancel(reason) { await reader.cancel(reason); },
    }) : null;
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()) });
  };
  return { fetch: fetcher, close: async () => { clearTimeout(timer); controller.abort(); await Promise.allSettled([...agents].map(agent => agent.destroy())); } };
}
