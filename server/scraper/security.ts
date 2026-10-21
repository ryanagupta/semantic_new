import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export const SCRAPE_TIMEOUT_MS = 15_000;
export const MAX_DOM_BYTES = 2 * 1024 * 1024;
export const MAX_RESULT_BYTES = 1024 * 1024;
export type PublicAddress = { address: string; family: 4 | 6 };
export type AddressResolver = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

/** Reject transition/mapped, private, metadata, multicast and reserved addresses. */
export function isPublicScrapeAddress(value: string): boolean {
  try {
    const address = ipaddr.parse(value);
    if (address.range() !== 'unicast') return false;
    if (address.kind() === 'ipv6') {
      const bytes = address.toByteArray();
      // Only globally routed IPv6 space. Deny special-purpose 2001::/23,
      // documentation, 6to4 and retired 6bone address space conservatively.
      if ((bytes[0] & 0xe0) !== 0x20) return false;
      const denied = ['2001::/23', '2001:db8::/32', '2002::/16', '3ffe::/16', '3fff::/20'];
      return !denied.some(cidr => address.match(ipaddr.parseCIDR(cidr)));
    }
    return !['192.0.0.0/24', '192.88.99.0/24', '198.18.0.0/15'].some(cidr => address.match(ipaddr.parseCIDR(cidr)));
  } catch { return false; }
}

export function parseScrapeUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('Enter a valid public HTTP or HTTPS URL.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a valid public HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Scraping requires an HTTP(S) URL without credentials or a fragment.');
  const expectedPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port && url.port !== expectedPort) throw new Error('Only public HTTP and HTTPS ports are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || (!isIP(host) && !host.includes('.')) || host === 'localhost' || /\.(localhost|local|localdomain|internal|lan|home|home\.arpa|test|invalid|onion)$/.test(host)) throw new Error('Local and private hosts cannot be scraped.');
  if (isIP(host) && !isPublicScrapeAddress(host)) throw new Error('Local, private and reserved addresses cannot be scraped.');
  url.hostname = host.includes(':') ? `[${host}]` : host;
  return url;
}

const systemResolver: AddressResolver = hostname => lookup(hostname, { all: true, verbatim: true });

/** Validate every DNS answer and return the exact address to connect to. */
export async function resolveScrapeTarget(value: string | URL, resolver: AddressResolver = systemResolver): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  const url = parseScrapeUrl(typeof value === 'string' ? value : value.href);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(hostname);
  let addresses: readonly { address: string; family: number }[];
  let timer: NodeJS.Timeout | undefined;
  try {
    addresses = literal ? [{ address: hostname, family: literal }] : await Promise.race([
      resolver(hostname),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup timed out.')), 5000); timer.unref(); }),
    ]);
  }
  catch { throw new Error('The target host could not be resolved.'); }
  finally { if (timer) clearTimeout(timer); }
  if (!addresses.length || addresses.some(entry => ![4, 6].includes(entry.family) || !isPublicScrapeAddress(entry.address))) throw new Error('The target resolves to a private or reserved network.');
  const target = addresses.find(entry => entry.family === 4) ?? addresses[0];
  return { url, address: target.address, family: target.family as 4 | 6 };
}

export async function validateTargetUrl(value: string): Promise<void> { await resolveScrapeTarget(value); }

export function scrapeDeadline(signal?: AbortSignal, timeoutMs = SCRAPE_TIMEOUT_MS): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Scrape cancelled.'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Scrape exceeded the 15 second execution limit.')), Math.max(1, Math.min(timeoutMs, SCRAPE_TIMEOUT_MS)));
  timer.unref();
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Scrape cancelled or execution time limit reached.');
}

export async function withScrapeAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  assertNotAborted(signal);
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('Scrape cancelled or execution time limit reached.'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}
