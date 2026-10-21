import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'nexus-transports-')), 'test.db');
process.env.NODE_ENV = 'test';
const { mountWebSocket } = await import('../server/bridge/websocket.js');
const { billingStore } = await import('../server/billing/store.js');

test('Custom WebSocket transport negotiates JSON-RPC, returns parse errors, and rechecks revocation', async () => {
  let accepted = true, authCalls = 0;
  const server = createServer((_req, res) => res.end());
  mountWebSocket(server, { listEndpoints: () => [], execute: async () => { throw new Error('No tool must execute.'); }, authenticateToken: async token => { authCalls++; if (token !== 'test-credential' || !accepted) throw Object.assign(new Error('Unauthorized'), { status: 401 }); return { id: 'dashboard', scopes: ['admin'], rateLimit: 60 }; } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Authorization: 'Bearer test-credential' } });
  const receive = async (data: unknown) => {
    const response = once(client, 'message');
    client.send(typeof data === 'string' ? data : JSON.stringify(data));
    return JSON.parse(String((await response)[0]));
  };
  try {
    await once(client, 'open');
    const initialized = await receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'websocket-test', version: '1.0.0' } } });
    assert.equal(initialized.result.serverInfo.name, 'nexusmcp');
    client.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.deepEqual((await receive({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools, []);
    const malformed = await receive('{');
    assert.equal(malformed.error.code, -32700);
    assert.equal(malformed.id, null);
    accepted = false;
    const closed = once(client, 'close');
    client.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
    assert.equal((await closed)[0], 1008);
    assert(authCalls >= 5, 'The connection must reauthenticate each message.');
  } finally { client.terminate(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); billingStore.close(); }
});
