import { setTimeout as delay } from 'node:timers/promises';
import { generateScraper } from '../agent/generator.js';
import { scraperConfiguration, scraperSettings } from './settings.js';
import { scraperStore } from './store.js';
import { billingStore } from '../billing/store.js';
import { audit, maskText } from '../telemetry/logger.js';

export function startScraperWorkers() {
  const stop = new AbortController();
  const workers: Promise<void>[] = [];
  if (scraperConfiguration().configured) for (let n = 0; n < scraperSettings.SCRAPER_WORKER_CONCURRENCY; n++) {
    workers.push((async () => {
      while (!stop.signal.aborted) {
        const job = scraperStore.claim();
        if (!job) { await delay(750, undefined, { signal: stop.signal }).catch(() => {}); continue; }
        const leaseAbort = new AbortController();
        const heartbeat = setInterval(() => { if (!scraperStore.heartbeat(job)) leaseAbort.abort(new Error('Worker lease lost.')); }, 10000);
        heartbeat.unref();
        try {
          const signal = AbortSignal.any([stop.signal, leaseAbort.signal, AbortSignal.timeout(300000)]);
          const artifact = await generateScraper(job.input, message => { if (!scraperStore.heartbeat(job)) throw new Error('Worker lease lost.'); scraperStore.log(job.id, message); }, signal);
          signal.throwIfAborted();
          scraperStore.complete(job, artifact, Math.min(60, billingStore.snapshot().maxRateLimit));
        } catch (error) {
          if (!stop.signal.aborted) {
            const message = maskText(error instanceof Error ? error.message : 'The scraper build failed.').slice(0, 1500);
            scraperStore.fail(job, message); audit('scraper.build.failed', { jobId: job.id, message });
          }
          // Shutdown leaves an expiring lease, which a new process can recover.
        } finally { clearInterval(heartbeat); }
      }
    })().catch(error => audit('scraper.worker.stopped', { error: error instanceof Error ? error.message : 'Worker failed' })));
  }
  return async () => { stop.abort(new Error('Gateway is shutting down.')); await Promise.allSettled(workers); };
}
