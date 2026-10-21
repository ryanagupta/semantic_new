import { z } from 'zod';
import { config } from '../config.js';

const env = z.object({
  SCRAPER_ENABLED: z.enum(['true', 'false']).default('false'),
  SCRAPER_BROWSERLESS_URL: z.url().optional().or(z.literal('')),
  SCRAPER_BROWSERLESS_TOKEN: z.string().optional(),
  SCRAPER_EGRESS_PROXY_URL: z.url().optional().or(z.literal('')),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().min(1).max(150).default('openai/gpt-4o'),
  SCRAPER_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
}).parse(process.env);

export const scraperSettings = { ...env, enabled: env.SCRAPER_ENABLED === 'true' };
export function scraperConfiguration() {
  const missing: string[] = [];
  if (!scraperSettings.enabled) missing.push('SCRAPER_ENABLED');
  for (const key of ['SCRAPER_BROWSERLESS_URL', 'SCRAPER_BROWSERLESS_TOKEN', 'SCRAPER_EGRESS_PROXY_URL', 'OPENROUTER_API_KEY'] as const) {
    if (!env[key]) missing.push(key);
  }
  if (!config.REDIS_URL) missing.push('REDIS_URL');
  return { configured: missing.length === 0, missing };
}

export const createScraperInput = z.object({
  targetUrl: z.string().trim().url().max(2048),
  prompt: z.string().trim().min(20).max(8000),
  cacheTtlSeconds: z.number().int().min(0).max(86400).default(300),
}).strict();
export type CreateScraperInput = z.infer<typeof createScraperInput>;
