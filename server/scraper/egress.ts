import http, { type Server } from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { resolveScrapeTarget, type AddressResolver } from './security.js';

const MAX_TUNNEL_BYTES = 32 * 1024 * 1024;
const MAX_CONNECTIONS = 256;
const blocked = 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 23\r\n\r\nDestination not allowed';
const hopHeaders = new Set(['proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** Browserless has no internet-facing network; all its outbound traffic passes here. */
export function createEgressProxy(options: { resolver?: AddressResolver } = {}): Server {
  const sockets = new Set<net.Socket>();
  const server = http.createServer({ maxHeaderSize: 16_384, requestTimeout: 20_000, headersTimeout: 10_000 }, (incoming, outgoing) => {
    void (async () => {
      if (!incoming.url || !['GET', 'HEAD', 'POST', 'OPTIONS'].includes(incoming.method ?? '')) { outgoing.writeHead(403).end('Destination not allowed'); return; }
      const target = await resolveScrapeTarget(incoming.url, options.resolver);
      if (incoming.destroyed || outgoing.destroyed) return;
      // HTTPS must use CONNECT; refusing absolute HTTPS requests avoids cleartext leaks.
      if (target.url.protocol !== 'http:') throw new Error('Unsupported proxy request.');
      const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([key]) => !hopHeaders.has(key.toLowerCase())));
      headers.host = target.url.host;
      const upstream = http.request({ hostname: target.address, family: target.family, port: 80, method: incoming.method, path: target.url.pathname + target.url.search, headers, timeout: 15_000, agent: false }, response => {
        const safeHeaders = Object.fromEntries(Object.entries(response.headers).filter(([key]) => !hopHeaders.has(key.toLowerCase())));
        outgoing.writeHead(response.statusCode ?? 502, safeHeaders);
        let bytes = 0;
        response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_TUNNEL_BYTES) { response.destroy(); outgoing.destroy(); } });
        response.on('error', () => outgoing.destroy());
        response.pipe(outgoing);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502).end('Upstream unavailable'); else outgoing.destroy(); });
      incoming.on('aborted', () => upstream.destroy());
      outgoing.on('close', () => upstream.destroy());
      let received = 0;
      incoming.on('data', (chunk: Buffer) => { received += chunk.length; if (received > 1_048_576) { incoming.destroy(); upstream.destroy(); } });
      incoming.pipe(upstream);
    })().catch(() => { if (!outgoing.headersSent) outgoing.writeHead(403).end('Destination not allowed'); else outgoing.destroy(); });
  });
  server.on('connect', (request, client, head) => {
    const clientSocket = client as net.Socket;
    void (async () => {
      const authority = request.url ?? '';
      if (!/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):(?:80|443)$/.test(authority)) throw new Error('Invalid authority.');
      const port = Number(authority.slice(authority.lastIndexOf(':') + 1));
      const target = await resolveScrapeTarget(`${port === 443 ? 'https' : 'http'}://${authority}/`, options.resolver);
      if (clientSocket.destroyed) return;
      const upstream = net.connect({ host: target.address, family: target.family, port });
      upstream.setTimeout(20_000, () => upstream.destroy());
      let connected = false;
      let bytes = head.length;
      const count = (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_TUNNEL_BYTES) { upstream.destroy(); clientSocket.destroy(); } };
      upstream.on('connect', () => {
        connected = true;
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        clientSocket.on('data', count);
        upstream.on('data', count);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.on('error', () => { if (!connected && !clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); else clientSocket.destroy(); });
      clientSocket.on('error', () => upstream.destroy());
      clientSocket.on('close', () => upstream.destroy());
      upstream.on('close', () => clientSocket.destroy());
    })().catch(() => { if (!clientSocket.destroyed) clientSocket.end(blocked); });
  });
  server.on('connection', socket => {
    if (sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setTimeout(20_000, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('close', () => { for (const socket of sockets) socket.destroy(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.SCRAPER_EGRESS_PORT ?? process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SCRAPER_EGRESS_PORT.');
  const server = createEgressProxy();
  server.listen(port, '0.0.0.0', () => console.info('Relay scraper egress proxy ready.'));
  const shutdown = () => { server.close(); server.closeAllConnections(); setTimeout(() => process.exit(0), 1000).unref(); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
