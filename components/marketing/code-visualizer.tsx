'use client';

import { ArrowRight, Braces, Check, ChevronRight, CircleDashed, Code2, Play, Zap } from 'lucide-react';
import { useState } from 'react';
import { CopyButton } from './copy-button';

const examples = [
  { label: 'Get a customer', method: 'GET', path: '/customers/{id}', operation: 'get_customer', description: 'Retrieve a customer by ID', property: 'id', schema: { type: 'string', description: 'The customer ID' }, arguments: { id: 'cus_001' } },
  { label: 'Search products', method: 'GET', path: '/products', operation: 'search_products', description: 'Search your product catalog', property: 'query', schema: { type: 'string', description: 'Product search query' }, arguments: { query: 'mechanical keyboard' } },
  { label: 'Create an order', method: 'POST', path: '/orders', operation: 'create_order', description: 'Create a new order', property: 'productId', schema: { type: 'string', description: 'The product to order' }, arguments: { productId: 'prod_042' } },
];

export function CodeVisualizer() {
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<'schema' | 'call'>('schema');
  const item = examples[selected];
  const source = `paths:\n  ${item.path}:\n    ${item.method.toLowerCase()}:\n      operationId: ${item.operation}\n      summary: ${item.description}\n` + (item.method === 'POST'
    ? `      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              properties:\n                productId:\n                  type: string\n              required: [productId]`
    : `      parameters:\n        - name: ${item.property}\n          in: ${item.path.includes('{') ? 'path' : 'query'}\n          required: true\n          schema:\n            type: string`);
  const tool = { name: item.operation, description: item.description, inputSchema: { type: 'object', properties: { [item.property]: item.schema }, required: [item.property] } };
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: item.operation, arguments: item.arguments } };
  const result = JSON.stringify(view === 'schema' ? tool : call, null, 2);
  return <div className="transform-window"><div className="window-toolbar"><div className="window-dots"><i /><i /><i /></div><span>From endpoint to intelligence</span><span className="local-label"><i className="status-dot" /> Interactive preview</span></div><div className="transform-tabs" role="tablist" aria-label="Example endpoints">{examples.map((example, index) => <button type="button" key={example.operation} role="tab" aria-selected={selected === index} className={selected === index ? 'selected' : ''} onClick={() => setSelected(index)}><Code2 size={14} />{example.label}</button>)}<span className="example-hint">Choose an endpoint <ChevronRight size={12} /></span></div><div className="transform-panels"><section className="transform-panel"><div className="panel-heading"><span><Braces size={15} /> Your OpenAPI spec</span><span className="file-type">openapi.yaml</span></div><div className="endpoint-bar"><span className={'method ' + item.method.toLowerCase()}>{item.method}</span><span>{item.path}</span><span className="endpoint-version">OAS 3.1</span></div><pre className="yaml-code"><code>{source.split('\n').map((line, index) => <span className="code-line" key={index}><span className="line-number">{index + 1}</span><span className={line.includes('operationId') || line.includes('summary') ? 'code-value' : ''}>{line}</span></span>)}</code></pre></section><div className="transform-connector"><span><Zap size={18} /></span><div /><ArrowRight size={14} /></div><section className="transform-panel result-panel"><div className="panel-heading"><span><CircleDashed size={15} /> Native MCP tool</span><CopyButton value={result} /></div><div className="result-toggle"><button type="button" onClick={() => setView('schema')} className={view === 'schema' ? 'selected' : ''}>Tool schema</button><button type="button" onClick={() => setView('call')} className={view === 'call' ? 'selected' : ''}><Play size={11} /> Tool call</button></div><pre className="json-code"><code>{result.split('\n').map((line, index) => <span key={index} className="code-line"><span className="line-number">{index + 1}</span><span>{line.split(/("[^"]*")/g).map((segment, i, parts) => <span key={i} className={segment.startsWith('"') ? parts[i + 1]?.trimStart().startsWith(':') ? 'code-key' : 'code-string' : ''}>{segment}</span>)}</span></span>)}</code></pre></section></div><div className="transform-status"><span><Check size={13} /> Schema generated locally</span><span>JSON-RPC 2.0 <i /> MCP compatible <i /> Zero glue code</span></div></div>;
}
