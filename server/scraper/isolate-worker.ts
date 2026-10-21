import ivm from 'isolated-vm';
import { MAX_RESULT_BYTES } from './security.js';

// There are deliberately no callbacks, References, ExternalCopies, Node objects,
// browser handles or native capabilities inside this isolated V8 context.
const bootstrap = String.raw`
  const source = $0;
  const pageUrl = $1;
  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  const pending = new Map();
  const queue = [];
  let sequence = 0;
  let completed = false;
  let output = null;
  let failure = null;
  const send = (method, steps, attribute) => {
    if (++sequence > 256) return Promise.reject(new Error('Scraper exceeded its 256 browser action limit.'));
    return new Promise((resolve, reject) => {
      pending.set(sequence, { resolve, reject });
      queue.push({ id: sequence, method, steps, ...(attribute !== undefined ? { attribute } : {}) });
    });
  };
  const locator = steps => Object.freeze({
    locator(selector) { if (typeof selector !== 'string' || !selector || selector.length > 500 || steps.length >= 12) throw new Error('Invalid selector.'); return locator([...steps, { kind: 'locator', selector }]); },
    nth(index) { if (!Number.isInteger(index) || index < 0 || index > 199 || steps.length >= 12) throw new Error('Row index must be between 0 and 199.'); return locator([...steps, { kind: 'nth', index }]); },
    first() { return this.nth(0); },
    async all() { const size = await send('count', steps); return Array.from({ length: Math.min(size, 200) }, (_, index) => locator([...steps, { kind: 'nth', index }])); },
    count() { return send('count', steps); },
    allTextContents() { return send('allTextContents', steps); },
    textContent() { return send('textContent', steps); },
    innerText() { return send('innerText', steps); },
    getAttribute(attribute) { return send('getAttribute', steps, attribute); }
  });
  const page = Object.freeze({
    url() { return pageUrl; },
    locator(selector) { if (typeof selector !== 'string' || !selector || selector.length > 500) throw new Error('Invalid selector.'); return locator([{ kind: 'locator', selector }]); }
  });
  Object.defineProperty(globalThis, '__relayBridge', { configurable: false, writable: false, value: Object.freeze({
    drain() { return stringify(queue.splice(0, 16)); },
    respond(serialized) { const message = parse(serialized); const request = pending.get(message.id); if (!request) return; pending.delete(message.id); if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value); },
    state() { return stringify({ completed, output, failure }); }
  }) });
  const invoke = new Function('page', '"use strict"; const scraper = (' + source + '); if (typeof scraper !== "function") throw new Error("Scraper must be a function expression."); return scraper(page);');
  Promise.resolve(invoke(page)).then(value => {
    const serialized = stringify(value);
    if (!serialized || serialized.length > 1048576) throw new Error('Scraper output must be JSON under 1 MB.');
    output = parse(serialized);
    completed = true;
  }).catch(error => { failure = String(error && error.message || 'Generated scraper failed.').slice(0, 500); completed = true; });
`;

let isolate: ivm.Isolate | undefined;
let context: ivm.Context | undefined;
let started = false;
let poll: NodeJS.Timeout | undefined;
const fail = (reason: string) => { if (process.connected) process.send?.({ type: 'error', error: reason }); cleanup(); };
function cleanup() { if (poll) clearTimeout(poll); try { isolate?.dispose(); } catch {} setTimeout(() => process.exit(0), 10).unref(); }
function tick() {
  if (!context) return;
  try {
    const operations = context.evalSync('__relayBridge.drain()', { timeout: 250 }) as string;
    if (operations.length > 65_536) throw new Error('Scraper operation batch exceeds the safety limit.');
    const batch: unknown = JSON.parse(operations);
    if (!Array.isArray(batch) || batch.length > 16) throw new Error('Invalid browser operations.');
    for (const operation of batch) process.send?.({ type: 'operation', operation });
    const serialized = context.evalSync('__relayBridge.state()', { timeout: 250 }) as string;
    if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES + 1024) throw new Error('Scraper output exceeds 1 MB.');
    const state = JSON.parse(serialized) as { completed: boolean; output: unknown; failure: string | null };
    if (state.completed) {
      if (state.failure) fail(state.failure);
      else { process.send?.({ type: 'done', result: state.output }); cleanup(); }
      return;
    }
    poll = setTimeout(tick, 5);
  } catch (error) {
    fail(error instanceof Error && /timed out/i.test(error.message) ? 'Generated scraper exceeded its CPU execution limit.' : error instanceof Error && /^Scraper (output|operation)/.test(error.message) ? error.message : 'Generated scraper failed in its isolated environment.');
  }
}
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const record = message as Record<string, unknown>;
  if (record.type === 'start' && !started) {
    started = true;
    if (typeof record.code !== 'string' || Buffer.byteLength(record.code) > 32_768 || typeof record.pageUrl !== 'string') { fail('Invalid scraper input.'); return; }
    try {
      isolate = new ivm.Isolate({ memoryLimit: 64, onCatastrophicError: () => process.exit(1) });
      context = isolate.createContextSync();
      context.evalClosureSync(bootstrap, [record.code, record.pageUrl], { timeout: 250 });
      tick();
    } catch { fail('Generated scraper could not initialize within its CPU or memory budget.'); }
  } else if (record.type === 'response' && context) {
    try {
      const serialized = JSON.stringify(record);
      if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES + 1024) throw new Error('Oversized browser response.');
      context.evalClosureSync('__relayBridge.respond($0)', [serialized], { timeout: 250 });
    } catch { fail('Generated scraper exceeded its CPU or memory limit while processing browser data.'); }
  }
});
process.once('disconnect', () => { cleanup(); process.exit(0); });
