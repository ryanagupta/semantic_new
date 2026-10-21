import Link from 'next/link';
import { ArrowUpRight, Braces, KeyRound, Network, ShieldCheck } from 'lucide-react';
import { CopyButton } from '@/components/marketing/copy-button';
import './editorial-sections.css';

const proxyExample = `const gateway = 'http://127.0.0.1:3001';
const endpoint = process.env.RELAY_ENDPOINT_ID;
const apiKey = process.env.NEXUS_API_KEY;
if (!endpoint || !apiKey) throw new Error('Set your endpoint and key');

const response = await fetch(
  gateway + '/gateway/' + encodeURIComponent(endpoint),
  { headers: { Authorization: 'Bearer ' + apiKey } }
);
if (!response.ok) throw new Error('Request failed: ' + response.status);
const result = await response.json();`;

const mcpExample = `import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport }
  from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const apiKey = process.env.NEXUS_API_KEY;
if (!apiKey) throw new Error('Set NEXUS_API_KEY');
const client = new Client({ name: 'my-agent', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(
  new URL('http://127.0.0.1:3001/mcp'),
  { requestInit: { headers: { Authorization: 'Bearer ' + apiKey } } }
);
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(tools);
} finally { await client.close(); }`;

function HighlightedCode({ code }: { code: string }) {
  const tokens = code.split(/('(?:[^'\\]|\\.)*'|\b(?:const|await|new|if|throw|import|from|try|finally)\b)/g);
  return <code>{tokens.map((token, index) => <span key={index} className={token.startsWith("'") ? 'relay-code-string' : /^(const|await|new|if|throw|import|from|try|finally)$/.test(token) ? 'relay-code-keyword' : undefined}>{token}</span>)}</code>;
}

function CodePanel({ code, title }: { code: string; title: string }) {
  return <div className="relay-api-code"><div className="relay-api-code-toolbar"><span><i/><i/><i/></span><span>{title}</span><CopyButton value={code} label={`Copy ${title} example`}/></div><pre tabIndex={0} aria-label={title}><HighlightedCode code={code}/></pre></div>;
}

export function ApiShowcase() {
  return <section className="relay-api-showcase" id="api" aria-labelledby="relay-api-title"><div className="relay-container relay-editorial-frame">
    <header className="relay-editorial-heading"><div><span className="relay-editorial-eyebrow">Relay for developers</span><h2 id="relay-api-title">Your next idea.<br/>A world of APIs behind it.</h2></div><Link href="/docs#quickstart" className="relay-editorial-button">Explore docs<ArrowUpRight size={15}/></Link></header>
    <div className="relay-api-row"><div className="relay-api-copy"><span className="relay-api-index">01 / REST GATEWAY</span><h3>Keep your APIs.<br/>Simplify the connection.</h3><p>Route requests to your configured endpoints through Relay. Bring authentication, access controls, and request telemetry into one place.</p><div className="relay-api-facts"><div><strong>Your existing services</strong><span>Use configured REST and GraphQL endpoints.</span></div><div><strong>One access layer</strong><span>Authenticate with a scoped Relay API key.</span></div></div><Link href="/docs#gateway-and-observability">Meet the gateway<ArrowUpRight size={14}/></Link></div><CodePanel code={proxyExample} title="gateway.ts"/></div>
    <div className="relay-api-row"><div className="relay-api-copy"><span className="relay-api-index">02 / MCP CONNECTION</span><h3>Give your agents<br/>the tools to do more.</h3><p>Discover schemas and call tools through a standard MCP connection. The official MCP SDK handles initialization and session negotiation.</p><div className="relay-api-facts"><div><strong>Discover, then call</strong><span>Inspect tool schemas before execution.</span></div><div><strong>Choose your transport</strong><span>Streamable HTTP, SSE, or local stdio.</span></div></div><Link href="/docs#transports">Connect an MCP client<ArrowUpRight size={14}/></Link></div><CodePanel code={mcpExample} title="agent.ts"/></div>
    <div className="relay-api-row relay-api-access"><div className="relay-api-copy"><span className="relay-api-index">03 / ACCESS & CONTROL</span><h3>Build freely.<br/>Stay in control.</h3><p>Choose which tools each key can use. Keep provider credentials on the server and monitor usage as your application grows.</p><Link href="/docs#security">Explore security<ArrowUpRight size={14}/></Link></div><div className="relay-api-access-art" role="img" aria-label="Applications connect through Relay with scoped keys to their APIs and MCP servers"><div className="relay-access-orbit"/><span className="relay-access-node relay-access-node-app"><Braces size={20}/>Your app</span><span className="relay-access-node relay-access-node-api"><Network size={20}/>APIs + MCPs</span><div className="relay-access-core"><ShieldCheck size={34} strokeWidth={1.3}/><strong>Relay</strong></div><div className="relay-access-key"><KeyRound size={14}/><span>Scoped key</span><code>tools:read</code></div><span className="relay-access-caption">Your tools. Your boundaries.</span></div></div>
    <p className="relay-api-note">Examples use a local Relay gateway. Configure a GET endpoint for the REST example and set your server-side environment variables before running.</p>
  </div></section>;
}
