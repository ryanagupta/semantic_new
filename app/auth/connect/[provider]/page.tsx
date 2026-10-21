'use client';

import { TextureButton } from '@/components/ui/texture-button';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, ArrowUpRight, Braces, Check, Link2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage, jsonBody } from '@/lib/api';
import type { McpProvider, McpRegistry } from '@/components/dashboard/providers';
import { Notice, Spinner } from '@/components/dashboard/ui';
import '@/app/dashboard/dashboard.css';

export default function ConnectProviderPage() {
  const { provider: providerId } = useParams<{ provider: string }>();
  const [provider, setProvider] = useState<McpProvider | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [externalIdentity, setExternalIdentity] = useState(false);
  const [bearerToken, setBearerToken] = useState('');
  useEffect(() => {
    let active = true;
    setExternalIdentity(new URLSearchParams(window.location.search).get('identity') === 'external');
    async function load() {
      try {
        const [registry, session] = await Promise.all([api<McpRegistry>('/mcps/public'), api<{ authenticated: boolean }>('/session')]);
        const selected = registry.providers.find(item => item.id === providerId);
        if (!selected) throw new Error('This provider is not available in the workspace registry.');
        if (active) { setProvider(selected); setAuthenticated(session.authenticated); }
      } catch (error) { if (active) setError(errorMessage(error)); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [providerId]);
  async function connect() {
    setBusy(true); setError('');
    try {
      if (externalIdentity && !bearerToken.trim()) throw new Error('Enter your Nexus bearer token to authenticate the identity being connected.');
      const result = await api<{ authUrl: string }>(`/oauth/${encodeURIComponent(providerId)}/start`, {
        ...jsonBody({}),
        ...(externalIdentity ? { headers: { Authorization: `Bearer ${bearerToken.trim()}` } } : {}),
      });
      const url = new URL(result.authUrl);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('The provider returned an invalid authorization URL.');
      setBearerToken('');
      window.location.assign(url.href);
    } catch (error) { setError(errorMessage(error)); setBusy(false); }
  }
  return <div className="dash-auth"><div className="dash-login dash-connect-card">
    <Link href="/" className="dash-brand"><span className="dash-logo"><Braces size={23} /></span>relay</Link>
    <div className="dash-login-icon"><Link2 size={27} /></div><div className="dash-eyebrow">CONNECT YOUR TOOLKIT</div>
    <h1>{provider ? `Connect ${provider.displayName}` : 'Connect a provider'}</h1>
    <p>Give your gateway permission to use tools from your provider account.</p>
    {loading ? <div className="dash-connect-loading"><Spinner label="Checking connection" /></div> : <>
      {error && <Notice>{error}</Notice>}
      {provider && <>
        <div className="dash-connect-details"><span><Check size={14} />Connection is bound to your authenticated Nexus identity</span><span><ShieldCheck size={14} />Credentials stay on the gateway</span><span><LockKeyhole size={14} />Your provider verifies access and subscription</span></div>
        <label className="dash-checkbox-label dash-external-toggle"><input type="checkbox" checked={externalIdentity} onChange={event => { setExternalIdentity(event.target.checked); setBearerToken(''); }} />Connect an external Nexus identity</label>
        {externalIdentity && <div className="dash-external-token"><label className="dash-label">Nexus bearer token<input className="dash-input" type="password" value={bearerToken} onChange={event => setBearerToken(event.target.value)} autoComplete="off" spellCheck={false} maxLength={16384} placeholder="Your Nexus API key or JWT" /><small>This token authenticates your identity to Relay. It stays in this page’s memory and is sent only to the Nexus gateway. Enter provider credentials on the provider’s authorization page.</small></label></div>}
        {provider.access === 'free' ? <Notice success>This integration is free and does not require an OAuth connection.</Notice> : !provider.authConfigured ? <Notice>The provider’s OAuth configuration is missing. Ask your workspace administrator to configure its client credentials and authorization endpoints.</Notice> : !externalIdentity && !authenticated ? <><Notice>Sign in to your workspace or connect an external Nexus identity to continue.</Notice><Link className="dash-button primary full" href="/dashboard">Sign in to your workspace <ArrowUpRight size={15} /></Link></> : <>
          <p className="dash-connect-disclosure">Continue to {provider.displayName} to sign in and review the requested permissions. A paid subscription at the provider may be required; your Relay plan does not grant provider access.</p>
          <TextureButton variant="primary" className="dash-texture-full" onClick={() => void connect()} disabled={busy || (externalIdentity && !bearerToken.trim())}>{busy ? <Spinner label="Opening authorization" /> : <>Continue to {provider.displayName} <ArrowUpRight size={15} /></>}</TextureButton>
        </>}
      </>}
    </>}
    <Link href="/dashboard/mcps" className="dash-back"><ArrowLeft size={14} />Back to MCP registry</Link>
  </div></div>;
}
