import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import { requireKey, type AuthedRequest } from '../auth.js';
import { tokenProtection } from '../middleware/security.js';
import { store } from '../store.js';
import { scraperStore } from '../scraper/store.js';
import { executeEndpoint } from '../execution.js';
import { HttpError } from '../errors.js';

const apiKeyHeader: RequestHandler = (req, _res, next) => {
  const key = req.get('X-API-Key');
  if (key) {
    if (req.headers.authorization || key.length > 256 || !/^nx_live_[A-Za-z0-9_-]+$/.test(key)) return next(new HttpError(401, 'Provide exactly one valid Relay API key.'));
    req.headers.authorization = `Bearer ${key}`;
  }
  next();
};
export function mountDynamicScraperRoutes(app: Express) {
  app.get('/api/v1/custom/:endpointId', apiKeyHeader, requireKey, tokenProtection, async (req, res) => {
    const id = z.uuid().parse(req.params.endpointId);
    if (Object.keys(req.query).length) throw new HttpError(400, 'This scraper has no request parameters; its source is fixed.');
    const scraper = scraperStore.get(id), endpoint = store.getEndpoint(id);
    if (!scraper?.enabled || !endpoint?.enabled) throw new HttpError(404, 'Scraper endpoint not found.');
    const principal = (req as AuthedRequest).nexusPrincipal;
    const result = await executeEndpoint(endpoint, {}, principal);
    res.status(result.status).type('application/json').send(result.body);
  });
}
