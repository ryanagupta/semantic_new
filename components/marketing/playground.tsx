'use client';

import { AlertCircle, ArrowUpRight, Braces, Check, Code2, RotateCcw, Terminal } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { CopyButton } from './copy-button';

const initial = 'curl https://api.example.com/v1/customers/42 \\\n  -H "Accept: application/json"';

function parseEndpoint(input: string) {
  const text = input.trim();
  if (!text) throw new Error('Paste a cURL command, an endpoint JSON object, or an HTTPS URL.');
  let url: string; let method = 'GET'; let name: string | undefined; let body: unknown;
  if (text.startsWith('{')) {
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The endpoint must be a JSON object.');
    const endpoint = data as Record<string, unknown>;
    if (typeof endpoint.url !== 'string') throw new Error('Add a "url" string to your endpoint JSON.');
    url = endpoint.url;
    if (endpoint.method !== undefined && typeof endpoint.method !== 'string') throw new Error('The HTTP method must be a string.');
    method = String(endpoint.method ?? 'GET').toUpperCase();
    if (endpoint.name !== undefined && (typeof endpoint.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(endpoint.name))) throw new Error('Tool names must use 1–64 letters, numbers, underscores, or hyphens.');
    name = endpoint.name as string | undefined; body = endpoint.body;
  } else {
    const tokens = text.replace(/\\\r?\n/g, ' ').match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)?.map(token => token.replace(/^(["'])(.*)\1$/s, '$2')) ?? [];
    if (tokens[0] === 'curl') tokens.shift();
    const methodIndex = tokens.findIndex(token => token === '-X' || token === '--request');
    if (methodIndex >= 0 && !tokens[methodIndex + 1]) throw new Error('Specify a method after -X.');
    method = methodIndex >= 0 ? tokens[methodIndex + 1].toUpperCase() : 'GET';
    const bodyIndex = tokens.findIndex(token => ['-d', '--data', '--data-raw', '--data-binary'].includes(token));
    if (bodyIndex >= 0) {
      if (!tokens[bodyIndex + 1]) throw new Error('Supply a JSON body after the data flag.');
      body = JSON.parse(tokens[bodyIndex + 1].replace(/\\"/g, '"')); if (methodIndex < 0) method = 'POST';
    }
    url = tokens.find(token => /^https?:\/\//.test(token)) ?? '';
  }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw new Error('Choose GET, POST, PUT, PATCH, DELETE, or HEAD.');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Enter a complete URL, such as https://api.example.com/customers.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS endpoints are supported.');
  if (parsed.username || parsed.password) throw new Error('Remove embedded credentials from your URL.');
  const segments = parsed.pathname.split('/').filter(Boolean).filter(segment => !/^v\d+$/.test(segment));
  const resource = segments.find(segment => !/^\d+$/.test(segment) && !segment.startsWith('{')) ?? 'endpoint';
  name ??= `${method.toLowerCase()}_${resource.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const properties: Record<string, unknown> = {}; const args: Record<string, unknown> = {};
  parsed.searchParams.forEach((value, key) => { properties[key] = { type: 'string', description: `Query parameter: ${key}` }; args[key] = value; });
  const required: string[] = [];
  for (const match of parsed.pathname.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) { properties[match[1]] = { type: 'string', description: `Path parameter: ${match[1]}` }; required.push(match[1]); args[match[1]] = 'your-value'; }
  if (body !== undefined) { properties.body = { type: Array.isArray(body) ? 'array' : body === null ? 'null' : typeof body === 'object' ? 'object' : typeof body }; args.body = body; required.push('body'); }
  return { name, method, host: parsed.hostname, schema: { name, description: `${method} ${parsed.pathname}`, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false } }, call: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } };
}

export function Playground() {
  const [input, setInput] = useState(initial);
  const [view, setView] = useState<'schema' | 'call'>('schema');
  const parsed = useMemo(() => { try { return { value: parseEndpoint(input), error: null }; } catch (error) { return { value: null, error: error instanceof SyntaxError ? 'Invalid JSON. Check your quotes, commas, and body syntax.' : error instanceof Error ? error.message : 'Unable to parse this endpoint.' }; } }, [input]);
  const output = parsed.value ? JSON.stringify(view === 'schema' ? parsed.value.schema : parsed.value.call, null, 2) : '';
  return <div className="playground-window"><div className="playground-split"><div className="playground-input"><div className="panel-heading"><span><Terminal size={15} /> Your endpoint</span><button type="button" className="text-button" onClick={() => setInput(initial)}><RotateCcw size={12} /> Reset</button></div><label htmlFor="endpoint-input" className="sr-only">cURL command or endpoint JSON</label><textarea id="endpoint-input" spellCheck={false} value={input} onChange={event => setInput(event.target.value)} /><div className="playground-presets"><span>Try an example</span><button onClick={() => setInput(initial)}>GET request</button><button onClick={() => setInput(JSON.stringify({ url: 'https://api.example.com/orders', method: 'POST', name: 'create_order', body: { productId: 'prod_042', quantity: 1 } }, null, 2))}>POST with body</button><button onClick={() => setInput('curl "https://api.example.com/products?query=keyboard&limit=10"')}>Query params</button></div></div><div className="playground-output"><div className="panel-heading"><span><Braces size={15} /> Generated MCP</span>{output && <CopyButton value={output} />}</div><div className="result-toggle"><button onClick={() => setView('schema')} className={view === 'schema' ? 'selected' : ''}>Tool schema</button><button onClick={() => setView('call')} className={view === 'call' ? 'selected' : ''}>JSON-RPC request</button></div>{parsed.error ? <div className="playground-error" role="status"><AlertCircle size={20} /><strong>Let’s check that endpoint</strong><p>{parsed.error}</p></div> : <pre className="json-code playground-json"><code>{output}</code></pre>}</div></div><div className="playground-status"><span>{parsed.value ? <><Check size={13} /> Valid schema <i /> {parsed.value.method} {parsed.value.host}</> : <><Code2 size={13} /> Waiting for a valid endpoint</>}</span><span>Runs locally in your browser. No requests sent.</span></div><div className="playground-next"><span>Ready to connect a real API?</span><Link href="/dashboard/endpoints">Create your first endpoint <ArrowUpRight size={14} /></Link></div></div>;
}
