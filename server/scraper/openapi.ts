import { config } from '../config.js';
import type { ScraperEndpoint } from './store.js';

export function scraperOpenApi(endpoint: ScraperEndpoint) {
  const path = `/api/v1/custom/${endpoint.id}`;
  return {
    openapi: '3.0.3', info: { title: endpoint.name, version: '1.0.0', description: `${endpoint.description}\n\nGenerated and verified by Relay. The schema reflects the verified sample; source changes can require a rebuild. Each request uses Relay rate limits and workspace usage credits.` },
    servers: [{ url: new URL(config.APP_ORIGIN).origin }],
    paths: { [path]: { get: { operationId: `scrape_${endpoint.id.replaceAll('-', '')}`, summary: endpoint.description,
      security: [{ ApiKey: [] }, { BearerKey: [] }],
      responses: {
        '200': { description: 'Verified scraped JSON', headers: { 'X-Relay-Scrape-Cache': { schema: { type: 'string', enum: ['HIT', 'MISS'] } } }, content: { 'application/json': { schema: endpoint.schema, example: endpoint.sample } } },
        '401': { description: 'Missing, invalid, or revoked Relay key' }, '403': { description: 'Key does not grant access to this tool' },
        '402': { description: 'Workspace usage quota exhausted' }, '404': { description: 'Endpoint disabled or removed' },
        '429': { description: 'Sliding-window rate limit exceeded' }, '502': { description: 'Source or verified schema changed' },
        '503': { description: 'Browser capacity, circuit breaker, or cache unavailable' }, '504': { description: '15-second scrape deadline exceeded' },
      } } } },
    components: { securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' }, BearerKey: { type: 'http', scheme: 'bearer', bearerFormat: 'Relay API key' } } },
  };
}
