import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, type McpDependencies } from './mcp.js';
import { config } from '../config.js';
import type { Principal } from '../../shared/types.js';
import { consumePrincipalRate, consumePreAuthenticationRate, consumeClassifiedIpRate } from '../middleware/security.js';

class NexusWebSocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private started = false;
  private queued = 0;
  constructor(private readonly socket: WebSocket, private readonly refreshPrincipal: () => Promise<void>) {}
  async start(): Promise<void> {
    if (this.started) throw new Error('WebSocket transport is already started.');
    this.started = true;
    this.socket.on('error', error => this.onerror?.(error));
    this.socket.on('close', () => this.onclose?.());
    let queue = Promise.resolve();
    this.socket.on('message', (data, binary) => {
      if(this.queued>=32){this.socket.close(1008,'Message backlog exceeded');return;}
      this.queued++;
      queue = queue.then(async () => {
        if(this.socket.readyState!==WebSocket.OPEN)return;
        try { await this.refreshPrincipal(); }
        catch { this.socket.close(1008, 'Authentication expired or revoked'); return; }
        if(this.socket.readyState!==WebSocket.OPEN)return;
        if (binary) { this.socket.close(1003, 'JSON text messages are required'); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(data.toString()); }
        catch { await this.sendError(-32700, 'Parse error.'); return; }
        const validated = JSONRPCMessageSchema.safeParse(parsed);
        if (!validated.success) { await this.sendError(-32600, 'Invalid JSON-RPC request.'); return; }
        this.onmessage?.(validated.data);
      }).catch(error => this.onerror?.(error instanceof Error ? error : new Error('WebSocket message failed.'))).finally(()=>{this.queued--;});
    });
  }
  async close(): Promise<void> { this.socket.close(1000, 'Server closed'); }
  private async sendError(code: number, message: string): Promise<void> {
    await new Promise<void>((resolve, reject) => this.socket.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }), error => error ? reject(error) : resolve()));
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket connection is closed.');
    await new Promise<void>((resolve, reject) => this.socket.send(JSON.stringify(message), error => error ? reject(error) : resolve()));
  }
}

/** Optional custom MCP transport extension. Standard clients should use /mcp or stdio. */
export function mountWebSocket(server: HttpServer, deps: Omit<McpDependencies, 'principal'> & { authenticateToken: (token: string) => Promise<Principal> }): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
  const principals = new Map<WebSocket, Principal>();
  let upgrades = 0;
  server.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { socket.destroy(); return; }
    if (pathname !== '/ws') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    if ((req.headers.origin && req.headers.origin !== new URL(config.APP_ORIGIN).origin) || wss.clients.size + upgrades >= 1000) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const authorization = req.headers.authorization;
    const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    upgrades++;
    const timeout = setTimeout(() => socket.destroy(), 5000);
    timeout.unref();
    const ip = req.socket.remoteAddress ?? 'unknown';
    void consumePreAuthenticationRate(ip).then(async () => {
      if(!token){await consumeClassifiedIpRate(ip,false);throw Object.assign(new Error('Unauthorized'),{status:401});}
      let current: Principal;
      try { current = await deps.authenticateToken(token); }
      catch (error) { await consumeClassifiedIpRate(ip, false); throw error; }
      await consumeClassifiedIpRate(ip, true);
      if (socket.destroyed) return;
      if ([...principals.values()].filter(principal => principal.id === current.id).length >= 20) { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        const principal = { ...current, scopes: [...current.scopes] };
        principals.set(ws, principal);
        const mcp = createMcpServer({ ...deps, principal });
        const ttl = setTimeout(() => ws.close(1000, 'Session expired; reconnect'), 30 * 60_000);
        ttl.unref();
        const transport = new NexusWebSocketTransport(ws, async () => {
          await consumePreAuthenticationRate(ip);
          let refreshed:Principal;
          try{refreshed=await deps.authenticateToken(token);}
          catch(error){await consumeClassifiedIpRate(ip,false);throw error;}
          await consumeClassifiedIpRate(ip,true);
          if (refreshed.id !== principal.id) throw new Error('Principal changed.');
          await consumePrincipalRate(refreshed);
          principal.scopes = refreshed.scopes;
          principal.rateLimit = refreshed.rateLimit;
        });
        ws.on('close', () => { clearTimeout(ttl); principals.delete(ws); void mcp.close(); });
        void mcp.connect(transport).catch(() => ws.close(1011, 'MCP initialization failed'));
      });
    }).catch(error => { if (!socket.destroyed) socket.end((error as { status?: number })?.status === 429 ? 'HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n' : 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); })
      .finally(() => { upgrades--; clearTimeout(timeout); });
  });
  server.on('close', () => { for (const client of wss.clients) client.terminate(); wss.close(); });
  return wss;
}
