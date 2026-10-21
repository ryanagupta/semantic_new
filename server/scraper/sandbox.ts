import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assertNotAborted, MAX_RESULT_BYTES, SCRAPE_TIMEOUT_MS } from './security.js';

const locatorStep = z.union([
  z.object({ kind: z.literal('locator'), selector: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal('nth'), index: z.number().int().min(0).max(199) }).strict(),
]);
const operationSchema = z.object({
  id: z.number().int().positive().max(256),
  method: z.enum(['count', 'allTextContents', 'textContent', 'innerText', 'getAttribute']),
  steps: z.array(locatorStep).min(1).max(12),
  attribute: z.string().regex(/^[a-zA-Z_:][a-zA-Z0-9_.:-]{0,79}$/).optional(),
}).strict();

export type ScraperOperation = z.infer<typeof operationSchema>;
export type ScraperRpc = (operation: ScraperOperation) => Promise<unknown>;

/** The child has no secrets; only JSON primitives cross the V8 isolate boundary. */
export async function runScraperSandbox(code: string, pageUrl: string, rpc: ScraperRpc, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
  assertNotAborted(options.signal);
  if (typeof code !== 'string' || code.length < 10 || Buffer.byteLength(code) > 32_768) throw new Error('Generated scraper must be a function expression under 32 KB.');
  const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './isolate-worker.ts' : './isolate-worker.js', import.meta.url);
  const execArgv = ['--no-node-snapshot', '--max-old-space-size=128', ...(workerUrl.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [])];
  const child = fork(fileURLToPath(workerUrl), [], {
    execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
    env: { NODE_ENV: 'production', ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let actions = 0;
    let totalBytes = 0;
    const seen = new Set<number>();
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      child.removeAllListeners('message');
      child.kill('SIGKILL');
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new Error('Scrape cancelled or execution time limit reached.'));
    const timer = setTimeout(() => finish(new Error('Scraper exceeded the 15 second execution limit.')), Math.max(1, Math.min(options.timeoutMs ?? SCRAPE_TIMEOUT_MS, SCRAPE_TIMEOUT_MS)));
    timer.unref();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    child.once('error', () => finish(new Error('The isolated scraper process could not start.')));
    child.once('exit', () => finish(new Error('The scraper exceeded its memory limit or exited unexpectedly.')));
    child.on('message', (message: unknown) => {
      if (settled || !message || typeof message !== 'object') return;
      const record = message as Record<string, unknown>;
      if (record.type === 'error') { finish(new Error(typeof record.error === 'string' ? record.error.slice(0, 500) : 'Generated scraper failed.')); return; }
      if (record.type === 'done') {
        try {
          const serialized = JSON.stringify(record.result);
          if (!serialized || Buffer.byteLength(serialized) > MAX_RESULT_BYTES) throw new Error('Scraper result exceeds the 1 MB limit or is not JSON.');
          finish(undefined, JSON.parse(serialized));
        } catch { finish(new Error('Scraper result exceeds the 1 MB limit or is not JSON.')); }
        return;
      }
      if (record.type !== 'operation') { finish(new Error('Invalid isolated scraper message.')); return; }
      const parsed = operationSchema.safeParse(record.operation);
      if (!parsed.success || ++actions > 256 || seen.has(parsed.data.id)) { finish(new Error('Scraper requested an unsupported operation or exceeded its action limit.')); return; }
      const operation = parsed.data;
      seen.add(operation.id);
      void (async () => {
        try {
          if (operation.method === 'getAttribute' && !operation.attribute) throw new Error('An attribute name is required.');
          const result = await rpc(operation);
          const serialized = JSON.stringify(result);
          const bytes = serialized ? Buffer.byteLength(serialized) : 0;
          totalBytes += bytes;
          if (!serialized || bytes > MAX_RESULT_BYTES || totalBytes > 8 * MAX_RESULT_BYTES) throw new Error('Extracted browser data exceeds the safety limit.');
          if (!settled && child.connected) child.send({ type: 'response', id: operation.id, value: JSON.parse(serialized) });
        } catch (error) {
          const reason = error instanceof Error ? error.message.slice(0, 350) : 'Browser extraction failed.';
          if (!settled && child.connected) child.send({ type: 'response', id: operation.id, error: reason });
        }
      })().catch(() => finish(new Error('The browser operation failed.')));
    });
    child.send({ type: 'start', code, pageUrl });
  });
}
