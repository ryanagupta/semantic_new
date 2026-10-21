'use client';
import { Check, ChevronDown, Globe2, Pencil, Play, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import type { Endpoint } from '@/shared/types';

export function EndpointConnection({ endpoint, busy, onToggle, onTest, onEdit, onDelete }: { endpoint: Endpoint; busy: boolean; onToggle: () => void; onTest: () => void; onEdit: () => void; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <article className={`console-endpoint-connection${expanded ? ' is-expanded' : ''}`}>
    <button className="console-endpoint-heading" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls={id}>
      <span className={`console-endpoint-state-icon${endpoint.enabled ? ' enabled' : ''}`}>{endpoint.enabled ? <Check size={14}/> : <Globe2 size={16}/>}</span>
      <span><strong>{endpoint.name}</strong><small>{endpoint.description || new URL(endpoint.url).hostname}</small></span><span className={`dash-method ${endpoint.method.toLowerCase()}`}>{endpoint.method}</span><ChevronDown size={16}/>
    </button>
    {expanded && <div className="console-endpoint-details" id={id}><div className="console-endpoint-details-heading"><div><span>UPSTREAM ENDPOINT</span><code>{endpoint.url}</code></div><div className="console-endpoint-controls"><button className={`dash-toggle ${endpoint.enabled ? 'on' : ''}`} role="switch" aria-checked={endpoint.enabled} aria-label={`${endpoint.enabled ? 'Disable' : 'Enable'} ${endpoint.name}`} onClick={onToggle} disabled={busy}><span/></button><span>{endpoint.enabled ? 'Enabled' : 'Disabled'}</span><button className="dash-button subtle" disabled={!endpoint.enabled || busy} onClick={onTest}><Play size={13}/>Test</button><button className="dash-icon-button" aria-label={`Edit ${endpoint.name}`} disabled={busy} onClick={onEdit}><Pencil size={15}/></button><button className="dash-icon-button danger" aria-label={`Delete ${endpoint.name}`} disabled={busy} onClick={onDelete}><Trash2 size={15}/></button></div></div><div className="console-endpoint-facts"><span>MCP tool<code>{endpoint.name}</code></span><span>API type<strong>{endpoint.kind === 'graphql' ? 'GraphQL' : 'REST'}</strong></span><span>Input mappings<strong>{endpoint.parameters.length} parameters</strong></span></div><details className="dash-schema-details"><summary>Tool input schema</summary><pre>{JSON.stringify(endpoint.inputSchema, null, 2)}</pre></details></div>}
  </article>;
}
