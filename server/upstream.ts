import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, request } from 'undici';
import type { Endpoint, ParameterMapping, UpstreamResult } from '../shared/types.js';
import { config } from './config.js';
import { validateArguments } from './bridge/validation.js';
import { acquireCircuit, type CircuitCompletion } from './gateway/circuit-breaker.js';

const forbiddenV4 = new BlockList();
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) forbiddenV4.addSubnet(network, bits, 'ipv4');
const publicV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');
const forbiddenV6 = new BlockList();
for (const [network, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20]] as const) forbiddenV6.addSubnet(network, bits, 'ipv6');

/** Conservative global unicast check; mapped IPv4 and transition networks are refused. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !forbiddenV4.check(address, 'ipv4');
  if (family === 6) return publicV6.check(address, 'ipv6') && !forbiddenV6.check(address, 'ipv6');
  return false;
}

export async function resolvePublicUpstream(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Upstream must be an HTTP(S) URL without credentials or fragment.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (config.upstreamAllowlist.length && !config.upstreamAllowlist.some(allowed => {
    if (allowed.startsWith('*.')) return hostname.endsWith(allowed.slice(1)) && hostname !== allowed.slice(2);
    return hostname === allowed.replace(/\.$/, '');
  })) throw new Error('Upstream host is outside UPSTREAM_ALLOWLIST.');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) throw new Error('Private upstream hosts are forbidden.');
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new Error('Upstream DNS resolves to a private, reserved, or non-public address.');
  const chosen = addresses.find(entry => entry.family === 4) ?? addresses[0];
  return { address: chosen.address, family: chosen.family as 4 | 6 };
}

/** Validate stored setup URLs before saving; request-time DNS validation remains mandatory. */
export async function validateUpstreamUrl(value: string): Promise<void> {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Upstream URL is invalid.'); }
  if (/[{}]/.test(url.hostname) || /%7[bd]/i.test(url.hostname)) throw new Error('Upstream hostname cannot contain argument templates.');
  await resolvePublicUpstream(url);
}

const protectedHeaders = /^(host|connection|content-length|transfer-encoding|te|trailer|upgrade|keep-alive|proxy-.*|forwarded|x-forwarded-.*|x-real-ip|cookie|set-cookie|accept-encoding)$/i;
const protectedParameterHeaders = /^(authorization|content-type)$/i;
const scalar = (value: unknown): string => {
  if (value === null) return 'null';
  if (['string', 'number', 'boolean'].includes(typeof value)) return String(value);
  throw new Error('Nested object and array parameter values are unsupported. Use a JSON request body.');
};
const pairs = (value: Record<string, unknown>) => Object.entries(value).map(([key, item]) => [key, scalar(item)] as const);
const simple = (value: unknown, explode = false): string => {
  if (Array.isArray(value)) return value.map(scalar).join(',');
  if (value !== null && typeof value === 'object') return pairs(value as Record<string, unknown>).map(([key, item]) => explode ? `${key}=${item}` : `${key},${item}`).join(',');
  return scalar(value);
};

function addQuery(url: URL, mapping: ParameterMapping, value: unknown) {
  const style = mapping.style ?? 'form';
  const explode = mapping.explode ?? style === 'form';
  if (Array.isArray(value)) {
    if (style === 'deepObject') throw new Error('deepObject query parameters require an object.');
    if (style === 'form' && explode) for (const item of value) url.searchParams.append(mapping.name, scalar(item));
    else url.searchParams.append(mapping.name, value.map(scalar).join(style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ','));
  } else if (value !== null && typeof value === 'object') {
    if (style === 'deepObject') for (const [key, item] of pairs(value as Record<string, unknown>)) url.searchParams.append(`${mapping.name}[${key}]`, item);
    else if (style === 'form' && explode) for (const [key, item] of pairs(value as Record<string, unknown>)) url.searchParams.append(key, item);
    else if (style === 'form') url.searchParams.append(mapping.name, simple(value));
    else throw new Error(`${style} query parameters require an array.`);
  } else url.searchParams.append(mapping.name, scalar(value));
}

/** Deterministically map tool arguments to the upstream request, without forwarding client headers. */
export function buildUpstreamRequest(endpoint: Endpoint, args: Record<string, unknown>): { url: URL; headers: Record<string, string>; body?: string } {
  validateArguments(endpoint, args);
  const configured = new URL(endpoint.url);
  if (/[{}]/.test(configured.hostname) || /%7[bd]/i.test(configured.hostname)) throw new Error('Upstream hostname cannot contain argument templates.');
  let path = endpoint.url;
  const headers: Record<string, string> = { accept: 'application/json, text/plain, image/*, application/octet-stream' };
  for (const [name, value] of Object.entries(endpoint.headers ?? {})) {
    if (protectedHeaders.test(name) || !/^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/.test(name) || /[\r\n]/.test(value)) throw new Error(`Unsafe upstream header ${name}.`);
    headers[name.toLowerCase()] = value;
  }
  const query: [ParameterMapping, unknown][] = [];
  for (const mapping of endpoint.parameters) {
    const property = mapping.inputProperty ?? mapping.name;
    const value = args[property];
    if (value === undefined) {
      if (mapping.required || mapping.in === 'path') throw new Error(`Missing required argument ${property}.`);
      continue;
    }
    if (mapping.in === 'path') {
      const marker = `{${mapping.name}}`;
      if (!path.includes(marker)) throw new Error(`Path parameter ${mapping.name} has no URL placeholder.`);
      const serialized = simple(value, mapping.explode);
      if (serialized === '.' || serialized === '..' || /[\x00-\x1F\x7F]/.test(serialized)) throw new Error(`Unsafe path argument ${mapping.name}.`);
      path = path.split(marker).join(encodeURIComponent(serialized));
    } else if (mapping.in === 'query') query.push([mapping, value]);
    else if (mapping.in === 'header') {
      if (protectedHeaders.test(mapping.name) || protectedParameterHeaders.test(mapping.name) || !/^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/.test(mapping.name)) throw new Error(`Protected header parameter ${mapping.name}.`);
      const serialized = simple(value, mapping.explode);
      if (/[\r\n]/.test(serialized)) throw new Error('Header values cannot contain newlines.');
      headers[mapping.name.toLowerCase()] = serialized;
    }
  }
  if (/\{[^}]+\}/.test(path)) throw new Error('An upstream path parameter is unresolved.');
  const url = new URL(path);
  if (url.origin !== configured.origin) throw new Error('Tool arguments cannot change the configured upstream origin.');
  for (const [mapping, value] of query) addQuery(url, mapping, value);
  let payload = endpoint.bodyProperty ? args[endpoint.bodyProperty] : undefined;
  if (endpoint.kind === 'graphql' && !endpoint.bodyProperty) {
    if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('GraphQL tools require a query string.');
    payload = { query: args.query, ...(args.variables !== undefined ? { variables: args.variables } : {}), ...(args.operationName !== undefined ? { operationName: args.operationName } : {}) };
  }
  let body: string | undefined;
  if (payload !== undefined) {
    if (endpoint.method === 'GET' || endpoint.method === 'HEAD') throw new Error('GET and HEAD upstreams cannot have a request body.');
    body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 1_048_576) throw new Error('Upstream request body exceeds 1 MB.');
    headers['content-type'] ??= 'application/json';
  }
  return { url, headers, body };
}

/** Each connection is pinned to a validated DNS answer; redirects never trigger an unvalidated hop. */
export async function executeUpstream(endpoint: Endpoint, args: Record<string, unknown>, circuitCompletion?: CircuitCompletion): Promise<UpstreamResult> {
  let built: ReturnType<typeof buildUpstreamRequest>;
  try { built = buildUpstreamRequest(endpoint, args); }
  catch (error) { circuitCompletion?.(null); throw error; }
  const { url, headers, body } = built;
  const controller = new AbortController();
  const timeout = Math.min(config.UPSTREAM_TIMEOUT_MS, 5000);
  const timer = setTimeout(() => controller.abort(new Error('Upstream request timed out.')), timeout);
  timer.unref();
  let dispatcher: Agent | undefined;
  let recordCircuit: CircuitCompletion | undefined = circuitCompletion;
  try {
    const target = await Promise.race([
      resolvePublicUpstream(url),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Upstream DNS lookup timed out.')), { once: true })),
    ]);
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: target.address, family: target.family }]);
      else callback(null, target.address, target.family);
    };
    recordCircuit ??= acquireCircuit(endpoint.id);
    dispatcher = new Agent({ connect: { lookup: pinnedLookup, autoSelectFamily: false, timeout }, connections: 1, pipelining: 0 });
    // Undici request() with this fresh Agent has no redirect interceptor.
    const response = await request(url, { dispatcher, method: endpoint.method, headers, body, signal: controller.signal, headersTimeout: timeout, bodyTimeout: timeout });
    const declared = Number(response.headers['content-length'] ?? 0);
    if (declared > config.MAX_RESPONSE_BYTES) { response.body.destroy(); throw new Error('Upstream response exceeds the configured size limit.'); }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > config.MAX_RESPONSE_BYTES) { response.body.destroy(); throw new Error('Upstream response exceeds the configured size limit.'); }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    const contentType = String(response.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
    recordCircuit(response.statusCode >= 500);
    return { status: response.statusCode, contentType, body: bytes.toString('utf8'), bytes };
  } catch (error) {
    recordCircuit?.(true);
    throw error;
  } finally {
    clearTimeout(timer);
    await dispatcher?.close();
  }
}
