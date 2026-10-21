'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, Braces, Clock3, Code2, Download, FileJson2, Globe2, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ComponentProps } from 'react';
import type SwaggerUIComponent from 'swagger-ui-react';
import { api, errorMessage } from '@/lib/api';
import { CopyButton, Notice, Spinner } from './ui';
import { scraperCacheLabel, scraperCurl, scraperEndpointPath, type ScraperDetail } from './scraper-types';
import 'swagger-ui-react/swagger-ui.css';

type SwaggerProps = ComponentProps<typeof SwaggerUIComponent> & { validatorUrl: null };
const SwaggerUI = dynamic<SwaggerProps>(() => import('swagger-ui-react'), { ssr: false, loading: () => <div className="scraper-result-loading"><Spinner label="Loading interactive documentation"/></div> });

export function ScraperDocs({ endpointId }: { endpointId: string }) {
  const [endpoint, setEndpoint] = useState<ScraperDetail | null>(null);
  const [error, setError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    void api<ScraperDetail>(`/scrapers/${encodeURIComponent(endpointId)}`, { signal: abort.signal }).then(setEndpoint).catch(cause => { if (!abort.signal.aborted) setError(errorMessage(cause)); });
    return () => abort.abort();
  }, [endpointId]);

  function downloadSpec() {
    if (!endpoint) return;
    let url = '';
    try {
      url = URL.createObjectURL(new Blob([JSON.stringify(endpoint.spec, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `relay-${endpoint.id}-openapi.json`; link.click();
      setDownloadError('');
    } catch { setDownloadError('The specification could not be downloaded. Copy the JSON below instead.'); }
    finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  const guardRequest: NonNullable<SwaggerProps['requestInterceptor']> = request => {
    const target = new URL(request.url, window.location.origin);
    if (target.origin !== window.location.origin || target.pathname !== scraperEndpointPath(endpointId) || String(request.method).toUpperCase() !== 'GET') throw new Error('Interactive requests are restricted to this Relay scraper endpoint.');
    return { ...request, credentials: 'omit' };
  };

  return <div className="relay-scrapers scraper-docs-page"><Link className="scraper-back" href="/dashboard/scrapers"><ArrowLeft size={15}/>Scraper builder</Link>{error && <Notice>{error}</Notice>}{downloadError && <Notice>{downloadError}</Notice>}{!endpoint && !error && <div className="dash-panel scraper-result-loading"><Spinner label="Loading endpoint documentation"/></div>}{endpoint && <>
    <header className="scraper-docs-heading"><div><div className="scraper-docs-eyebrow"><span className="scraper-icon violet"><FileJson2 size={20}/></span><span>RELAY / CUSTOM API</span><span className={endpoint.enabled ? 'scraper-status enabled' : 'scraper-status'}>{endpoint.enabled ? 'Live' : 'Paused'}</span></div><h1>{endpoint.name}</h1><p>{endpoint.description}</p></div><button className="dash-button" onClick={downloadSpec}><Download size={15}/>Download OpenAPI</button></header>
    <div className="scraper-docs-summary"><div><Globe2 size={16}/><span>Source website<strong>{new URL(endpoint.targetUrl).hostname}</strong></span></div><div><Clock3 size={16}/><span>Freshness<strong>{scraperCacheLabel(endpoint.cacheTtlSeconds)}</strong></span></div><div><ShieldCheck size={16}/><span>Authentication<strong>X-API-Key</strong></span></div></div>
    {!endpoint.enabled && <Notice>This endpoint is paused. Enable it in the scraper builder before sending a test request.</Notice>}
    <section className="dash-panel scraper-docs-quickstart"><div><h2>Make your first request</h2><p>Use the key revealed after your build. In the explorer below, choose Authorize to enter it for this tab.</p></div><div className="scraper-curl"><div><span>cURL</span><CopyButton value={scraperCurl(endpoint.id)} label="Copy command"/></div><pre><code>{scraperCurl(endpoint.id)}</code></pre></div></section>
    <section className="dash-panel scraper-swagger" aria-label="Interactive API documentation"><div className="scraper-explorer-heading"><div><Braces size={18}/><h2>API explorer</h2></div><span>OpenAPI 3.0</span></div><SwaggerUI spec={endpoint.spec} validatorUrl={null} persistAuthorization={false} withCredentials={false} supportedSubmitMethods={endpoint.enabled ? ['get'] : []} requestInterceptor={guardRequest} docExpansion="list" defaultModelsExpandDepth={1} displayRequestDuration tryItOutEnabled={false}/></section>
    <div className="scraper-docs-details"><details className="dash-panel"><summary><Braces size={16}/>Verified sample output</summary><div><CopyButton value={JSON.stringify(endpoint.sample, null, 2)}/><pre><code>{JSON.stringify(endpoint.sample, null, 2)}</code></pre></div></details><details className="dash-panel"><summary><Code2 size={16}/>Generated extraction function</summary><div><CopyButton value={endpoint.code}/><pre><code>{endpoint.code}</code></pre></div></details><details className="dash-panel"><summary><FileJson2 size={16}/>OpenAPI specification</summary><div><CopyButton value={JSON.stringify(endpoint.spec, null, 2)}/><pre><code>{JSON.stringify(endpoint.spec, null, 2)}</code></pre></div></details></div>
    <div className="scraper-bottom-note"><ShieldCheck size={15}/><p>API keys entered into the explorer stay in memory for this page. Authorization is not saved between visits.</p><Link href="/docs#scraper-builder">Builder guide<ArrowUpRight size={13}/></Link></div>
  </>}</div>;
}
