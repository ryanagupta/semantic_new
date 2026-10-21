import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { importOpenApi } from '../server/bridge/openapi.js';
import { createMcpServer, normalizeToolResult } from '../server/bridge/mcp.js';
import { buildUpstreamRequest, isPublicAddress, resolvePublicUpstream, validateUpstreamUrl } from '../server/upstream.js';
import { sanitizeArguments } from '../server/mcp/guardrails.js';
import { CircuitBreaker, CircuitOpenError } from '../server/gateway/circuit-breaker.js';
import type { Endpoint, EndpointInput, Principal } from '../shared/types.js';

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return { id: 'test_endpoint', name: 'get_items', description: 'List items', enabled: true, url: 'https://api.example.com/items', method: 'GET', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, parameters: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
}
const principal: Principal = { id: 'test_key', scopes: ['tools:read', 'tools:call'], rateLimit: 60 };

test('OpenAPI imports local references, nullable input, parameter collisions and vendor JSON bodies', () => {
  const [input] = importOpenApi({
    openapi: '3.0.3', servers: [{ url: 'https://api.example.com/v1' }],
    components: { schemas: { Create: { type: 'object', properties: { label: { type: 'string', nullable: true } }, required: ['label'], additionalProperties: false } } },
    paths: { '/items/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], post: { operationId: 'writeItem', parameters: [{ name: 'id', in: 'query', schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/vnd.item+json': { schema: { $ref: '#/components/schemas/Create' } } } }, responses: { '200': { description: 'OK' } } } } },
  });
  assert.equal(input.url, 'https://api.example.com/v1/items/{id}');
  assert.equal(input.parameters[1].inputProperty, 'query_id');
  assert.equal(input.headers?.['content-type'], 'application/vnd.item+json');
  const request = buildUpstreamRequest(endpoint(input as EndpointInput), { id: 7, query_id: 'second', body: { label: null } });
  assert.equal(request.url.href, 'https://api.example.com/v1/items/7?id=second');
  assert.equal(request.body, '{"label":null}');
});

test('OpenAPI rejects circular/external references and unsupported serialization atomically', () => {
  assert.throws(() => importOpenApi({ openapi: '3.1.0', paths: {}, components: { schemas: { Node: { $ref: '#/components/schemas/Node' } } } }), /Circular reference/);
  assert.throws(() => importOpenApi({ openapi: '3.1.0', paths: {}, components: { schemas: { Node: { $ref: 'https://malicious.example/schema' } } } }), /Only local/);
  assert.throws(() => importOpenApi({ openapi: '3.0.3', servers: [{ url: 'https://api.example.com' }], paths: { '/items': { get: { parameters: [{ name: 'id', in: 'query', style: 'matrix', schema: { type: 'string' } }] } } } }), /Unsupported query parameter style/);
});

test('Tool arguments strip unknown fields, preserve declared JSON, and reject injection at nested paths', () => {
  const tool = endpoint({ method: 'POST', bodyProperty: 'body', inputSchema: { type: 'object', properties: { body: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false } }, required: ['body'], additionalProperties: false } });
  assert.deepEqual(sanitizeArguments(tool, { body: { label: 'safe', untrusted: true }, other: 'ignored' }), { body: { label: 'safe' } });
  for (const label of ['value; rm -rf', 'x | cmd', '$(whoami)', 'UNION SELECT password', "' OR 1=1", '../secrets', '..\\secrets', '%252e%252e%252fsecret']) {
    assert.throws(() => sanitizeArguments(tool, { body: { label } }), /forbidden/i);
  }
  assert.throws(() => sanitizeArguments(tool, { body: {} }), /validation failed/i);
});

test('Parameter serialization maps arrays and deepObject safely and blocks origin/header injection', () => {
  const tool = endpoint({ url: 'https://api.example.com/items/{id}', parameters: [{ name: 'id', in: 'path', required: true }, { name: 'tags', in: 'query', style: 'form', explode: true }, { name: 'filter', in: 'query', style: 'deepObject' }], inputSchema: { type: 'object', properties: { id: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, filter: { type: 'object' } }, required: ['id'], additionalProperties: false } });
  const request = buildUpstreamRequest(tool, { id: 'a/b', tags: ['one', 'two'], filter: { state: 'ready' } });
  assert.equal(request.url.pathname, '/items/a%2Fb');
  assert.deepEqual(request.url.searchParams.getAll('tags'), ['one', 'two']);
  assert.equal(request.url.searchParams.get('filter[state]'), 'ready');
  assert.throws(() => buildUpstreamRequest({ ...tool, url: 'https://{id}.example.com' }, { id: 'evil' }), /hostname/);
  assert.throws(() => buildUpstreamRequest(endpoint({ headers: { host: 'localhost' } }), {}), /Unsafe upstream header/);
});

test('SSRF policy blocks special IPv4, mapped IPv6, local hosts and templates', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.10', '100.64.0.1', '192.0.2.5', '224.0.0.1', '::1', '::ffff:8.8.8.8', 'fc00::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  await assert.rejects(resolvePublicUpstream(new URL('http://127.1/')), /private|non-public/);
  await assert.rejects(validateUpstreamUrl('http://{host}.example.com/path'), /hostname/);
  await assert.rejects(validateUpstreamUrl('http://localhost/'), /Private/);
});

test('Circuit opens after majority failures and needs five successful recovery probes', () => {
  let now = 1;
  const breaker = new CircuitBreaker('circuit', () => now);
  for (const failed of [true, false, true, false, true]) breaker.acquire()(failed);
  assert.equal(breaker.state, 'OPEN');
  assert.throws(() => breaker.acquire(), CircuitOpenError);
  now += 15_000;
  assert.equal(breaker.state, 'HALF_OPEN');
  const probes = Array.from({ length: 5 }, () => breaker.acquire());
  assert.throws(() => breaker.acquire(), CircuitOpenError);
  probes.forEach(record => record(false));
  assert.equal(breaker.state, 'CLOSED');
  breaker.acquire()(false);
});

test('Official SDK client negotiates and invokes tools, resources and prompts', async () => {
  const tool = endpoint();
  let calls = 0;
  const server = createMcpServer({ listEndpoints: () => [tool], principal, execute: async () => { calls++; return { status: 200, contentType: 'application/json', body: '{"ok":true}' }; } });
  const client = new Client({ name: 'nexus-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    assert.equal((await client.listTools()).tools[0].name, 'get_items');
    const result = await client.callTool({ name: 'get_items', arguments: { ignored: 'safe' } });
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: 'text', text: '{\n  "ok": true\n}' }]);
    assert.equal((await client.listResources()).resources[0].uri, 'nexus://endpoints/test_endpoint');
    assert.equal((await client.readResource({ uri: 'nexus://endpoints/test_endpoint' })).contents.length, 1);
    assert.equal((await client.listPrompts()).prompts[0].name, 'invoke_tool');
    assert.equal((await client.getPrompt({ name: 'invoke_tool', arguments: { tool: 'get_items', goal: 'List available items' } })).messages.length, 1);
    assert.equal(calls, 2);
    await assert.rejects(client.callTool({ name: 'missing', arguments: {} }), /Unknown or unauthorized/);
  } finally { await client.close(); await server.close(); }
});

test('Resource-only and prompt-only scopes work independently of tool execution', async () => {
  for (const scope of ['resources:read', 'prompts:read']) {
    const server = createMcpServer({ listEndpoints: () => [endpoint()], principal: { ...principal, scopes: [scope] }, execute: async () => ({ status: 200, contentType: 'application/json', body: '{}' }) });
    const client = new Client({ name: 'scope-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      assert.equal((await client.listTools()).tools.length, 0);
      if (scope === 'resources:read') assert.equal((await client.readResource({ uri: 'nexus://endpoints/test_endpoint' })).contents.length, 1);
      else assert.equal((await client.getPrompt({ name: 'invoke_tool', arguments: { tool: 'get_items', goal: 'Plan a call' } })).messages.length, 1);
      await assert.rejects(client.callTool({ name: 'get_items' }), /Unknown or unauthorized/);
    } finally { await client.close(); await server.close(); }
  }
});

test('Binary upstream results become MCP image or embedded-resource content', () => {
  const bytes = Buffer.from([1, 2, 3]);
  assert.deepEqual(normalizeToolResult({ status: 200, contentType: 'image/png', body: '', bytes }, endpoint()).content, [{ type: 'image', mimeType: 'image/png', data: 'AQID' }]);
  assert.equal(normalizeToolResult({ status: 200, contentType: 'application/pdf', body: '', bytes }, endpoint()).content[0].type, 'resource');
  assert.equal(normalizeToolResult({ status: 503, contentType: 'text/plain', body: 'unavailable' }, endpoint()).isError, true);
});
