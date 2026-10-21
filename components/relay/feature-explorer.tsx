'use client';

import Image from 'next/image';
import { ArrowUpRight, Braces, Check, KeyRound, Network, Search, ShieldCheck, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type KeyboardEvent } from 'react';
import './feature-explorer.css';

const features = [
  { title: 'Discover your next connection', description: 'Explore APIs and MCP servers in one directory. Find the tools your application needs, from open-source utilities to providers you connect with your own account.', icon: Search, image: '/images/relay-developer-tools.png', alt: 'Silver laptop beside an iridescent glass sphere', prompt: 'Find the right tools for your next idea', label: 'A world of tools. One directory.', detail: 'Explore providers, inspect available tools, and choose what to connect.', steps: ['Discover', 'Inspect', 'Connect'], code: ['Design & development', 'Thinking & reasoning', 'Media generation'], href: '/dashboard/mcps', link: 'Explore the directory' },
  { title: 'Make APIs agent-ready', description: 'Bring an OpenAPI specification into Relay and turn API operations into discoverable MCP tools. Give your agents a consistent way to call the services you already use.', icon: Braces, image: '/images/relay-agent-workflows.png', alt: 'Iridescent glass loops connecting ceramic spheres', prompt: 'Turn an API operation into an MCP tool', label: 'From endpoint to tool.', detail: 'Map parameters, inspect the schema, and connect your agent.', steps: ['OpenAPI', 'Tool schema', 'Agent'], code: ['GET /projects/{id}', '→ projects_get', '→ tools/call'], href: '/docs#quickstart', link: 'See how bridging works' },
  { title: 'Bring your MCPs together', description: 'Connect the MCP servers your agents rely on through a shared gateway. Discover their tools and choose the transport that fits your application or local agent.', icon: Network, image: '/images/relay-connected-infrastructure.png', alt: 'Pastel glass towers joined by polished metal paths', prompt: 'Bring your MCP servers into one connection', label: 'Your tools, in sync.', detail: 'A consistent entry point for your application’s connected servers.', steps: ['Servers', 'Relay', 'Your agent'], code: ['Streamable HTTP', 'Server-Sent Events', 'Standard input / output'], href: '/docs#transports', link: 'Explore transports' },
  { title: 'Keep access in your hands', description: 'Connect provider accounts, scope API keys, and control tool permissions. Keep credentials on the server while giving each application the access it needs.', icon: ShieldCheck, image: '/images/relay-agent-workflows.png', alt: 'Softly colored glass forms linked together', prompt: 'Give each application the right level of access', label: 'One connection. Clear boundaries.', detail: 'Provider credentials stay behind the gateway.', steps: ['Authenticate', 'Check scopes', 'Execute'], code: ['Authorization: ••••••••', 'Scope: tools:call', 'Provider token: protected'], href: '/docs#security', link: 'Explore access controls' },
  { title: 'Understand every request', description: 'Inspect MCP schemas, simulate tool calls, and review request telemetry. Keep an eye on usage and upstream errors as your integrations grow.', icon: Sparkles, image: '/images/relay-connected-infrastructure.png', alt: 'Connected translucent glass infrastructure', prompt: 'Follow a tool call from request to response', label: 'See the whole connection.', detail: 'Inspect requests and responses alongside gateway telemetry.', steps: ['Request', 'Upstream', 'Response'], code: ['jsonrpc: "2.0"', 'method: "tools/call"', 'result: { content: […] }'], href: '/docs#gateway-and-observability', link: 'Explore observability' },
] as const;

export function FeatureExplorer() {
  const [active, setActive] = useState(0);
  const controls = useRef<(HTMLButtonElement | null)[]>([]);
  const feature = features[active];
  const Icon = feature.icon;

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % features.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + features.length - 1) % features.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = features.length - 1;
    else return;
    event.preventDefault();
    setActive(next);
    controls.current[next]?.focus();
  }

  return <section className="relay-feature-explorer relay-container" aria-label="Explore what you can build with Relay">
    <div className="relay-explorer-shell">
      <div className="relay-explorer-options" role="tablist" aria-label="Relay capabilities" aria-orientation="vertical">
        {features.map((item, index) => <div key={item.title} className={`relay-explorer-option${active === index ? ' is-selected' : ''}`} role="presentation">
          <button ref={element => { controls.current[index] = element; }} id={`relay-feature-tab-${index}`} role="tab" aria-selected={active === index} aria-controls="relay-feature-panel" tabIndex={active === index ? 0 : -1} onClick={() => setActive(index)} onKeyDown={event => onKeyDown(event, index)}>{item.title}<span aria-hidden="true">↗</span></button>
          {active === index && <p className="relay-explorer-description">{item.description}</p>}
        </div>)}
      </div>
      <div id="relay-feature-panel" className="relay-explorer-panel" role="tabpanel" aria-labelledby={`relay-feature-tab-${active}`} tabIndex={0}>
        <div className="relay-explorer-scene" key={feature.title}>
          <div className="relay-explorer-image"><Image src={feature.image} alt={feature.alt} fill sizes="(max-width: 700px) 85vw, 560px"/><div className="relay-explorer-image-shade"/><span className="relay-explorer-preview-label">RELAY / PRODUCT PREVIEW</span><div className="relay-explorer-image-caption"><Icon size={27} strokeWidth={1.4}/><h3>{feature.label}</h3></div></div>
          <div className="relay-explorer-prompt"><span><Icon size={16}/></span><p>{feature.prompt}</p><ArrowUpRight size={15}/></div>
          <div className="relay-explorer-result"><div><span className="relay-explorer-status-dot"/> Connection preview<KeyRound size={12}/></div><p>{feature.detail}</p><div className="relay-explorer-code">{feature.code.map(line => <span key={line}>{line}</span>)}</div><span className="relay-explorer-result-line"/></div>
          <div className="relay-explorer-steps">{feature.steps.map((step, index) => <div key={step}><span>0{index + 1}</span><p>{step}</p><Check size={12}/></div>)}</div>
        </div>
        <Link href={feature.href} className="relay-explorer-link">{feature.link}<ArrowUpRight size={15}/></Link>
      </div>
    </div>
  </section>;
}
