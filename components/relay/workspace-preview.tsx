'use client';
import { ArrowUpRight, Braces, Check, ChevronDown, Code2, Globe, KeyRound, Layers3, Network, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { RelayLogo } from './brand';
import { useState } from 'react';

const examples = [
  { name: 'Weather API', kind: 'API', category: 'Public data', access: 'Scoped API key' },
  { name: 'Your REST API', kind: 'API', category: 'Custom endpoint', access: 'Scoped API key' },
  { name: 'ReactBits', kind: 'MCP', category: 'Design', access: 'Provider configuration' },
  { name: 'Sequential Thinking', kind: 'MCP', category: 'Thinking', access: 'Provider configuration' },
  { name: 'Mobbin', kind: 'MCP', category: 'Design', access: 'Provider account' },
];

export function GatewayPreview({light=false}:{light?:boolean}={}) {
  const [filter, setFilter] = useState('All tools');
  const [selected, setSelected] = useState(0);
  const visible = examples.map((entry, index) => ({ ...entry, index })).filter(entry => filter === 'All tools' || entry.kind === (filter === 'REST APIs' ? 'API' : 'MCP'));
  const active = examples[selected];
  const request = active.kind === 'API'
    ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: selected === 0 ? 'get_weather' : 'your_operation', arguments: selected === 0 ? { city: 'London' } : {} } }
    : { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  function chooseFilter(value: string) {
    setFilter(value);
    if (value === 'REST APIs') setSelected(0);
    if (value === 'MCPs') setSelected(2);
  }
  return <div className="relay-preview-shell relay-gateway-preview" id="gateway">
    <div className="relay-preview-toolbar"><div><span className="relay-preview-dot"/>Interface preview<ChevronDown size={13}/></div><Link href="/dashboard/gateway">Open console<ArrowUpRight size={13}/></Link></div>
    <div className="relay-preview-body">
      <aside className="relay-preview-sidebar"><div className="relay-preview-sidebar-brand"><RelayLogo compact tone={light?'dark':'light'}/></div>
        {['All tools', 'REST APIs', 'MCPs'].map((name, index) => <button key={name} className={filter === name ? 'active' : ''} aria-pressed={filter === name} onClick={() => chooseFilter(name)}>{index === 0 ? <Layers3 size={16}/> : index === 1 ? <Globe size={16}/> : <Network size={16}/>}<span>{name}</span></button>)}
        <div className="relay-preview-divider"/><span className="relay-sidebar-label">Manage</span>
        <Link className="relay-preview-sidebar-link" href="/dashboard/keys"><KeyRound size={15}/>API keys<ArrowUpRight size={12}/></Link>
        <Link className="relay-preview-sidebar-link" href="/dashboard/mcp-inspector"><Code2 size={15}/>MCP inspector<ArrowUpRight size={12}/></Link>
        <div className="relay-preview-user"><span><RelayLogo compact decorative tone={light?'dark':'light'}/></span><div>Your gateway<small>One connection.</small></div></div>
      </aside>
      <div className="relay-preview-main"><div className="relay-preview-breadcrumb"><span>Gateway / {filter}</span><span>Example configuration</span></div>
        <div className="relay-preview-title"><div><h3>Your tools, connected.</h3><p>Select a service to explore its example MCP request.</p></div></div>
        <div className="relay-gateway-demo-grid"><div className="relay-service-list">
          {visible.map(entry => <button key={entry.name} className={selected === entry.index ? 'selected' : ''} aria-pressed={selected === entry.index} onClick={() => setSelected(entry.index)}><span className="relay-service-icon">{entry.kind === 'API' ? <Globe size={18}/> : <Network size={18}/>}</span><span><strong>{entry.name}</strong><small>{entry.category}</small></span><span className="relay-service-type">{entry.kind}</span><ArrowUpRight size={13}/></button>)}
        </div><section className="relay-protocol-preview" aria-live="polite"><div><span>{active.name}</span><Braces size={16}/></div><pre>{JSON.stringify(request, null, 2)}</pre><span><ShieldCheck size={13}/>{active.access}</span></section></div>
        <div className="relay-preview-bottom"><span><Check size={12}/>REST APIs + MCP servers</span><span>Illustrative requests · no live calls</span></div>
      </div>
    </div>
  </div>;
}
