import { getRelayRuntime } from '@/server/relay/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 360;

async function handle(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  try {
    const instance = getRelayRuntime(); await instance.ready;
    const session = await instance.auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: 'Sign in to manage your scrapers.' }, { status: 401 });
    const { signScraperIdentity, scraperIdentityHeader } = await import('@/server/scraper/identity');
    const configured = new URL(process.env.APP_ORIGIN || 'http://localhost:3000').origin;
    const origin = request.headers.get('origin');
    if (origin && origin !== configured || request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: 'Cross-site request rejected.' }, { status: 403 });
    const { path = [] } = await context.params;
    if (path.length > 4 || path.some(segment => !/^[a-zA-Z0-9_-]+$/.test(segment))) return Response.json({ error: 'Route not found.' }, { status: 404 });
    const upstream = new URL(`/api/scrapers${path.length ? '/' + path.join('/') : ''}`, process.env.GATEWAY_INTERNAL_URL || 'http://127.0.0.1:3001');
    const incoming = new URL(request.url); if (incoming.search.length > 256) return Response.json({ error: 'Query too long.' }, { status: 400 });
    upstream.search = incoming.search;
    let body: Uint8Array | undefined;
    if (!['GET', 'HEAD'].includes(request.method)) {
      const reader = request.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      if (reader) for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 65536) { await reader.cancel(); return Response.json({ error: 'Request body exceeds 64 KB.' }, { status: 413 }); } chunks.push(part.value); }
      if (bytes) body = new Uint8Array(Buffer.concat(chunks));
    }
    const headers = new Headers({ [scraperIdentityHeader]: await signScraperIdentity(session.user.id), accept: request.headers.get('accept') || 'application/json' });
    for (const name of ['cookie', 'origin', 'last-event-id']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
    if (body) headers.set('content-type', 'application/json');
    const result = await fetch(upstream, { method: request.method, headers, body: body as BodyInit | undefined,
      redirect: 'error', cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(path.at(-1) === 'events' ? 365000 : 20000)]) });
    const responseHeaders = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    for (const name of ['content-type', 'x-accel-buffering', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
      const value = result.headers.get(name); if (value) responseHeaders.set(name, value);
    }
    return new Response(result.body, { status: result.status, headers: responseHeaders });
  } catch {
    return Response.json({ error: 'The Relay scraper service is unavailable. Try again shortly.' }, { status: 503 });
  }
}
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
