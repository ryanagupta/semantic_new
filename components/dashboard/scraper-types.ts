export interface ScraperEndpoint {
  id: string;
  name: string;
  description: string;
  targetUrl: string;
  cacheTtlSeconds: number;
  enabled: boolean;
  createdAt: string;
}

export interface ScraperDirectory {
  configured: boolean;
  missing: string[];
  endpoints: ScraperEndpoint[];
}

export interface ScraperDetail extends ScraperEndpoint {
  endpointUrl: string;
  docsUrl: string;
  sample: unknown;
  spec: Record<string, unknown>;
  code: string;
}

export interface ScraperJob {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  error?: string;
  endpointId?: string;
}

export interface ScraperLog {
  id: string;
  message: string;
  time: string;
}

export function scraperCacheLabel(seconds: number) {
  return seconds === 0 ? 'No cache' : seconds < 60 ? `${seconds}s cache` : seconds < 3600 ? `${Math.round(seconds / 60)}m cache` : `${Math.round(seconds / 3600)}h cache`;
}

export function scraperEndpointPath(id: string) {
  return `/api/v1/custom/${encodeURIComponent(id)}`;
}

export function scraperCurl(id: string) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return [
    "curl '" + origin + scraperEndpointPath(id) + "' \\",
    "  -H 'X-API-Key: YOUR_RELAY_API_KEY'",
  ].join('\n');
}
