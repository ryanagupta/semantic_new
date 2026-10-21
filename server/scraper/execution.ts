import { randomUUID } from 'node:crypto';
import type { UpstreamResult } from '../../shared/types.js';
import type { CircuitCompletion } from '../gateway/circuit-breaker.js';
import { HttpError } from '../errors.js';
import { limiter } from '../limiter.js';
import { requestContext } from '../execution.js';
import { executeScraper } from './browser.js';
import { scraperStore, type ScraperEndpoint } from './store.js';
import { scraperConfiguration } from './settings.js';
import { validateStoredOutput } from './schema.js';

let active = 0;
const releaseLock = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`;
function asResult(value: unknown, cache: 'HIT' | 'MISS'): UpstreamResult {
  const response = requestContext.getStore()?.response;
  if (response && !response.headersSent) response.setHeader('X-Relay-Scrape-Cache', cache);
  return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(value) };
}

/** Called by the ordinary Relay execution path, after scope/rate/quota/circuit checks. */
export async function executeGeneratedScraper(endpoint: ScraperEndpoint, reservation: CircuitCompletion): Promise<UpstreamResult> {
  try {
    if (!scraperConfiguration().configured) throw new HttpError(503, 'The Relay scraper runtime is not configured.');
    const redis = limiter.client;
    if (!redis?.isReady) throw new HttpError(503, 'Scraper cache and concurrency service unavailable.');
    const cacheKey = `relay:scrape:cache:${endpoint.id}`, lockKey = `relay:scrape:lock:${endpoint.id}`;
    if (endpoint.cacheTtlSeconds > 0) {
      const cached = await redis.get(cacheKey);
      if (cached !== null) { const value = JSON.parse(cached) as unknown; validateStoredOutput(endpoint.schema, value); reservation(null); return asResult(value, 'HIT'); }
    }
    const lease = randomUUID();
    if (!await redis.set(lockKey, lease, { NX: true, EX: 20 })) throw new HttpError(503, 'This endpoint is refreshing. Retry in a few seconds.');
    try {
      if (active >= 2) throw new HttpError(503, 'Scraper execution capacity reached. Retry shortly.');
      active++;
      try {
        const value = await executeScraper(endpoint.targetUrl, endpoint.code);
        validateStoredOutput(endpoint.schema, value);
        // Recheck state after browser work, so disabling/removing a scraper takes effect immediately.
        const current = scraperStore.get(endpoint.id);
        if (!current?.enabled) throw new HttpError(404, 'Endpoint disabled or removed.');
        if (endpoint.cacheTtlSeconds > 0) await redis.set(cacheKey, JSON.stringify(value), { EX: endpoint.cacheTtlSeconds });
        reservation(false); return asResult(value, 'MISS');
      } finally { active--; }
    } finally { await redis.eval(releaseLock, { keys: [lockKey], arguments: [lease] }).catch(() => {}); }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : /time|cancel|limit reached/i.test(error instanceof Error ? error.message : '') ? 504 : 502;
    reservation(status >= 500 && status !== 503 ? true : null);
    if (error instanceof HttpError) throw error;
    throw new HttpError(status, status === 504 ? 'Scrape exceeded the 15-second execution deadline.' : 'Scrape failed. The source may have changed; rebuild this scraper in Relay.');
  }
}
