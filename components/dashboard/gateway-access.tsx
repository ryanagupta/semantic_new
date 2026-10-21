'use client';

import { ShieldCheck, ArrowUpRight, RefreshCw } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, errorMessage, jsonBody } from '@/lib/api';
import { Notice, Spinner } from './ui';

export function GatewayAccess({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api<{ authenticated: boolean }>('/session', { signal: controller.signal }).then(session => { if (!controller.signal.aborted) { setAuthenticated(session.authenticated); setError(''); } }).catch(error => { if (!controller.signal.aborted) { setError(errorMessage(error)); setAuthenticated(false); } });
    const unauthorized = () => setAuthenticated(false);
    window.addEventListener('nexus:unauthorized', unauthorized);
    return () => { controller.abort(); window.removeEventListener('nexus:unauthorized', unauthorized); };
  }, [retry]);

  async function signIn(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try { await api('/session', jsonBody({ password })); setAuthenticated(true); setPassword(''); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  if (authenticated === null) return <div className="console-gateway-loading"><Spinner label="Connecting to your gateway"/></div>;
  if (authenticated) return children;
  return <div className="console-owner-wrap"><section className="console-owner-card"><span className="console-owner-icon"><ShieldCheck size={29}/></span><span className="console-eyebrow">WORKSPACE ACCESS</span><h1>Connect to your gateway.</h1><p>Enter the workspace owner password to manage its APIs, tools, and access keys.</p>{error && <Notice>{error}</Notice>}<form onSubmit={signIn}><label className="dash-label" htmlFor="gateway-password">Workspace password</label><input className="dash-input" id="gateway-password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)}/><button className="dash-button primary full" disabled={busy}>{busy ? <Spinner label="Connecting"/> : <>Open gateway<ArrowUpRight size={16}/></>}</button></form><button className="console-retry" onClick={() => { setAuthenticated(null); setRetry(value => value + 1); }}><RefreshCw size={13}/>Check connection again</button></section></div>;
}
