import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { rateHeaders } from '../middleware/security.js';
import { HttpError } from '../errors.js';
import { limiter } from '../limiter.js';
import { createScraperInput, scraperConfiguration } from './settings.js';
import { scraperStore, type ScraperEndpoint, type ScraperJob } from './store.js';
import { requireScraperIdentity, type ScraperRequest } from './identity.js';
import { resolveScrapeTarget } from './security.js';
import { scraperOpenApi } from './openapi.js';
import { consumeQuota } from '../middleware/quotas.js';

const owner = (req: import('express').Request) => (req as ScraperRequest).scraperUserId;
const jobView = (job: ScraperJob) => ({ id: job.id, status: job.status, error: job.error, endpointId: job.endpointId, createdAt: job.createdAt });
const endpointView = ({ ownerId: _owner, keyId: _key, code: _code, schema: _schema, sample: _sample, ...endpoint }: ScraperEndpoint) => endpoint;

export function scraperRouter() {
  const router = Router(); router.use(requireScraperIdentity);
  router.use(async (req,res,next)=>{try{rateHeaders(res,await limiter.consume(`scraper:manage:${owner(req)}`,120));next();}catch(error){next(error);}});
  router.get('/', (req, res) => res.json({ ...scraperConfiguration(), endpoints: scraperStore.list(owner(req)).map(endpointView) }));
  router.post('/jobs', async (req, res) => {
    if (!scraperConfiguration().configured || !limiter.client?.isReady) throw new HttpError(503, 'Configure the managed browser, egress proxy, OpenRouter, and Redis to enable scraper builds.');
    await limiter.consume(`scraper:build:${owner(req)}`, 3, 3600000);
    const input = createScraperInput.parse(req.body);
    await resolveScrapeTarget(input.targetUrl);
    await consumeQuota();
    const job = scraperStore.createJob(owner(req), input);
    res.status(202).json({ id: job.id });
  });
  router.get('/jobs/:id', (req, res) => {
    const job = scraperStore.getJob(z.uuid().parse(req.params.id), owner(req));
    if (!job) throw new HttpError(404, 'Build not found.'); res.json(jobView(job));
  });
  router.get('/jobs/:id/events', async (req, res) => {
    const id = z.uuid().parse(req.params.id), userId = owner(req);
    if (!scraperStore.getJob(id, userId)) throw new HttpError(404, 'Build not found.');
    await limiter.consume(`scraper:streams:${userId}`, 20);
    const initial = req.get('Last-Event-ID') || req.query.after || '0';
    let after = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(initial);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let ended = false;
    const finish = () => { if (ended) return; ended = true; clearInterval(timer); clearTimeout(deadline); res.end(); };
    const tick = () => {
      if (ended || res.writableEnded) return finish();
      const job = scraperStore.getJob(id, userId); if (!job) return finish();
      for (const event of scraperStore.events(id, after)) {
        after = Number(event.id);
        if (!res.write(`id: ${event.id}\nevent: log\ndata: ${JSON.stringify(event)}\n\n`)) return finish();
      }
      if (job.status === 'succeeded' || job.status === 'failed') { res.write(`event: done\ndata: ${JSON.stringify(jobView(job))}\n\n`); finish(); }
      else res.write(': heartbeat\n\n');
    };
    const timer = setInterval(tick, 1000), deadline = setTimeout(finish, 360000);
    req.once('close', finish); res.once('error', finish); tick();
  });
  router.post('/jobs/:id/reveal', (req, res) => res.json({ apiKey: scraperStore.reveal(z.uuid().parse(req.params.id), owner(req)) }));
  router.get('/:id', (req, res) => {
    const endpoint = scraperStore.get(z.uuid().parse(req.params.id), owner(req));
    if (!endpoint) throw new HttpError(404, 'Scraper not found.');
    res.json({ ...endpointView(endpoint), code: endpoint.code, sample: endpoint.sample,
      endpointUrl: `${new URL(config.APP_ORIGIN).origin}/api/v1/custom/${endpoint.id}`,
      docsUrl: `/dashboard/scrapers/${endpoint.id}/docs`, spec: scraperOpenApi(endpoint) });
  });
  router.patch('/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id), { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    const endpoint = scraperStore.setEnabled(id, owner(req), enabled);
    await limiter.client?.del(`relay:scrape:cache:${id}`); res.json(endpointView(endpoint));
  });
  router.delete('/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id); scraperStore.delete(id, owner(req));
    await limiter.client?.del(`relay:scrape:cache:${id}`); res.status(204).end();
  });
  return router;
}
