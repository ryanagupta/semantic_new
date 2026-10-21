'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Braces, Check, CheckCircle2, ChevronDown, Clock3, Code2, Eye, EyeOff, FileJson2, Globe2, KeyRound, LoaderCircle, RefreshCw, ScanSearch, ShieldCheck, Sparkles, Terminal, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { api, ApiError, errorMessage } from '@/lib/api';
import { CopyButton, EmptyState, formatDate, Modal, Notice, PageHeader, Spinner } from './ui';
import { scraperCacheLabel, scraperCurl, scraperEndpointPath, type ScraperDetail, type ScraperDirectory, type ScraperEndpoint, type ScraperJob, type ScraperLog } from './scraper-types';

const activeJobStorage = 'relay:scraper:active-job';
const creationSchema = z.object({
  targetUrl: z.string().trim().url('Enter a complete website URL.').max(2048).refine(value => /^https?:\/\//i.test(value), 'Use an HTTP or HTTPS website URL.'),
  prompt: z.string().trim().min(20, 'Describe the fields you want in at least 20 characters.').max(8000, 'Keep your description under 8,000 characters.'),
  cacheTtlSeconds: z.number().int().min(0).max(86400),
});
const running = (job: ScraperJob | null) => job?.status === 'queued' || job?.status === 'running';

function rememberJob(id: string | null) {
  try { if (id) sessionStorage.setItem(activeJobStorage, id); else sessionStorage.removeItem(activeJobStorage); } catch { /* The current job also works when browser storage is disabled. */ }
}

export function ScraperBuilder() {
  const [directory, setDirectory] = useState<ScraperDirectory | null>(null);
  const [directoryError, setDirectoryError] = useState('');
  const [error, setError] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cacheTtlSeconds, setCacheTtlSeconds] = useState(300);
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [job, setJob] = useState<ScraperJob | null>(null);
  const [logs, setLogs] = useState<ScraperLog[]>([]);
  const [streamState, setStreamState] = useState<'idle' | 'live' | 'reconnecting'>('idle');
  const [result, setResult] = useState<ScraperDetail | null>(null);
  const [resultError, setResultError] = useState('');
  const [resultTab, setResultTab] = useState<'sample' | 'code'>('sample');
  const [apiKey, setApiKey] = useState('');
  const [revealing, setRevealing] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [busyEndpoint, setBusyEndpoint] = useState('');
  const [deleting, setDeleting] = useState<ScraperEndpoint | null>(null);
  const terminal = useRef<HTMLDivElement>(null);
  const activeJob = running(job);

  const load = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try { const value = await api<ScraperDirectory>('/scrapers', { signal }); setDirectory(value); setDirectoryError(''); }
    catch (cause) { if (!signal?.aborted) setDirectoryError(errorMessage(cause)); }
    finally { if (!signal?.aborted) setRefreshing(false); }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    let saved = '';
    try { saved = sessionStorage.getItem(activeJobStorage) ?? ''; } catch { return () => abort.abort(); }
    if (/^[\w-]{1,128}$/.test(saved)) {
      void api<ScraperJob>(`/scrapers/jobs/${encodeURIComponent(saved)}`, { signal: abort.signal }).then(value => { setJob(value); }).catch(cause => { if (!abort.signal.aborted) { rememberJob(null); if (!(cause instanceof ApiError && cause.status === 404)) setError(errorMessage(cause)); } });
    }
    return () => abort.abort();
  }, [load]);

  useEffect(() => {
    if (!job?.id || !activeJob) { setStreamState('idle'); return; }
    const id = job.id;
    const abort = new AbortController();
    const source = new EventSource(`/api/scrapers/jobs/${encodeURIComponent(id)}/events`, { withCredentials: true });
    let completed = false;
    const settle = (value: ScraperJob) => {
      if (abort.signal.aborted || value.id !== id) return;
      setJob(value);
      if (!running(value)) { completed = true; source.close(); setStreamState('idle'); void load(abort.signal); }
    };
    const readLog = (event: MessageEvent<string>) => {
      try {
        const value: unknown = JSON.parse(event.data);
        if (!value || typeof value !== 'object' || !('message' in value) || typeof value.message !== 'string') return;
        const item = value as Partial<ScraperLog>;
        const log: ScraperLog = { id: typeof item.id === 'string' ? item.id : event.lastEventId || `${item.time}:${item.message}`, message: item.message!, time: typeof item.time === 'string' ? item.time : new Date().toISOString() };
        setLogs(previous => previous.some(existing => existing.id === log.id) ? previous : [...previous, log].slice(-200));
      } catch { setStreamState('reconnecting'); }
    };
    const done = (event: MessageEvent<string>) => { try { settle(JSON.parse(event.data) as ScraperJob); } catch { setStreamState('reconnecting'); } };
    source.onopen = () => setStreamState('live');
    source.onerror = () => { if (!completed && !abort.signal.aborted) setStreamState('reconnecting'); };
    source.addEventListener('log', readLog as EventListener);
    source.addEventListener('done', done as EventListener);
    const poll = async () => {
      if (completed || abort.signal.aborted) return;
      try { settle(await api<ScraperJob>(`/scrapers/jobs/${encodeURIComponent(id)}`, { signal: abort.signal })); }
      catch (cause) { if (!abort.signal.aborted && cause instanceof ApiError && (cause.status === 401 || cause.status === 404)) { completed = true; source.close(); setStreamState('idle'); setError(errorMessage(cause)); } }
    };
    const interval = setInterval(() => void poll(), 5000);
    void poll();
    return () => { abort.abort(); source.close(); clearInterval(interval); };
  }, [job?.id, activeJob, load]);

  useEffect(() => { const element = terminal.current; if (element) element.scrollTop = element.scrollHeight; }, [logs]);

  useEffect(() => {
    if (job?.status !== 'succeeded' || !job.endpointId) return;
    const abort = new AbortController();
    setResultError('');
    void api<ScraperDetail>(`/scrapers/${encodeURIComponent(job.endpointId)}`, { signal: abort.signal }).then(setResult).catch(cause => { if (!abort.signal.aborted) setResultError(errorMessage(cause)); });
    return () => abort.abort();
  }, [job?.status, job?.endpointId]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = creationSchema.safeParse({ targetUrl, prompt, cacheTtlSeconds });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the website and scrape description.'); return; }
    setStarting(true); setError(''); setKeyError(''); setApiKey(''); setShowKey(false); setResult(null); setLogs([]); setResultError('');
    try { const value = await api<{ id: string }>('/scrapers/jobs', { method: 'POST', body: JSON.stringify(parsed.data) }); rememberJob(value.id); setJob({ id: value.id, status: 'queued' }); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setStarting(false); }
  }

  async function revealKey() {
    if (!job || job.status !== 'succeeded') return;
    setRevealing(true); setKeyError('');
    try { const value = await api<{ apiKey: string }>(`/scrapers/jobs/${encodeURIComponent(job.id)}/reveal`, { method: 'POST' }); setApiKey(value.apiKey); setShowKey(true); }
    catch (cause) { setKeyError(cause instanceof ApiError && cause.status === 410 ? 'This key has already been revealed or has expired. You can create another endpoint to receive a new key.' : errorMessage(cause)); }
    finally { setRevealing(false); }
  }

  async function toggle(endpoint: ScraperEndpoint) {
    setBusyEndpoint(endpoint.id); setError('');
    try { await api(`/scrapers/${encodeURIComponent(endpoint.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !endpoint.enabled }) }); await load(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusyEndpoint(''); }
  }

  async function remove() {
    if (!deleting) return;
    setBusyEndpoint(deleting.id); setError('');
    try {
      await api(`/scrapers/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' });
      if (job?.endpointId === deleting.id) { setJob(null); setResult(null); setApiKey(''); rememberJob(null); }
      setDeleting(null); await load();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusyEndpoint(''); }
  }

  return <div className="relay-scrapers">
    <PageHeader eyebrow="A WEBSITE. A PROMPT. AN API." title="Scraper builder" description="Turn the data you need from a public website into a reusable Relay endpoint."><Link className="dash-button" href="/docs#scraper-builder"><FileJson2 size={15}/>How it works<ArrowUpRight size={13}/></Link></PageHeader>
    {error && <Notice>{error}</Notice>}
    {directoryError && <Notice>{directoryError}<button className="dash-button subtle" onClick={() => void load()}>Try again</button></Notice>}
    {directory && !directory.configured && <div className="scraper-configuration" role="status"><span><ShieldCheck size={20}/></span><div><strong>Connect the builder infrastructure</strong><p>An administrator needs to configure {directory.missing.length ? directory.missing.join(', ') : 'the browser and model services'} before generation is available. Existing endpoints remain listed below.</p></div><Link href="/docs#scraper-builder">Setup guide<ArrowUpRight size={14}/></Link></div>}
    <div className="scraper-build-grid">
      <section className="dash-panel scraper-create-card"><div className="scraper-card-heading"><span className="scraper-icon violet"><ScanSearch size={21}/></span><div><h2>What do you want to extract?</h2><p>Describe the result. Relay handles the selectors.</p></div></div><form onSubmit={event => void create(event)}>
        <label className="scraper-field"><span>Target website<small>Public HTTP or HTTPS URL</small></span><div className="scraper-input-icon"><Globe2 size={17}/><input type="url" required maxLength={2048} placeholder="https://example.com/products" value={targetUrl} onChange={event => setTargetUrl(event.target.value)} disabled={starting || activeJob}/></div></label>
        <label className="scraper-field"><span>Scrape description<small>Be specific about fields and structure</small></span><textarea required minLength={20} maxLength={8000} rows={5} placeholder="Extract each product’s name, price, stock status, and product URL. Return an array of products." value={prompt} onChange={event => setPrompt(event.target.value)} disabled={starting || activeJob}/><span className="scraper-field-hint">Only request data you are authorized to access.<span>{prompt.length.toLocaleString()} / 8,000</span></span></label>
        <label className="scraper-field"><span>Cache freshness<small>Reuse recent results between requests</small></span><div className="scraper-select"><Clock3 size={17}/><select value={cacheTtlSeconds} onChange={event => setCacheTtlSeconds(Number(event.target.value))} disabled={starting || activeJob}><option value={0}>Always fetch fresh data</option><option value={60}>1 minute</option><option value={300}>5 minutes · Recommended</option><option value={900}>15 minutes</option><option value={3600}>1 hour</option><option value={86400}>24 hours</option></select><ChevronDown size={15}/></div></label>
        <div className="scraper-create-footer"><span><ShieldCheck size={14}/>Verified before publishing</span><button className="dash-button primary" type="submit" disabled={!directory?.configured || starting || activeJob}>{starting || activeJob ? <><LoaderCircle size={16} className="dash-spin"/>Building endpoint</> : <><Sparkles size={16}/>Generate API<ArrowRight size={15}/></>}</button></div>
      </form></section>
      <section className="scraper-terminal-card"><div className="scraper-terminal-heading"><span><Terminal size={16}/>Agent activity</span><span className={activeJob ? 'scraper-stream is-live' : 'scraper-stream'}><i/>{streamState === 'reconnecting' ? 'Reconnecting' : activeJob ? 'Live' : job?.status === 'succeeded' ? 'Complete' : job?.status === 'failed' ? 'Failed' : 'Ready'}</span></div><div className="scraper-terminal" ref={terminal} role="log" aria-label="Scraper generation activity" aria-live="polite" aria-relevant="additions text">{!logs.length && <div className="scraper-terminal-welcome"><span className="scraper-terminal-prompt">relay / scraper-builder</span><p>{activeJob ? 'Connected to your build. Waiting for agent activity…' : 'Your next API starts with a prompt.'}</p><span>01 <strong>Inspect the rendered page</strong></span><span>02 <strong>Generate an extraction function</strong></span><span>03 <strong>Verify the JSON output</strong></span><span>04 <strong>Publish your Relay endpoint</strong></span></div>}{logs.map(log => <div className="scraper-log-row" key={log.id}><time dateTime={log.time}>{Number.isNaN(Date.parse(log.time)) ? '—' : new Date(log.time).toLocaleTimeString([], { hour12: false })}</time><span>{log.message}</span></div>)}{activeJob && <div className="scraper-terminal-cursor"><span/>{streamState === 'reconnecting' ? 'Restoring the live stream. Build status is still being checked.' : 'Agent is working…'}</div>}{job?.status === 'failed' && <div className="scraper-terminal-error">{job.error || 'The agent could not verify this extraction. Refine the description or try another public page.'}</div>}{job?.status === 'succeeded' && <div className="scraper-terminal-success"><CheckCircle2 size={16}/>Verified. Your endpoint is ready.</div>}</div><div className="scraper-terminal-bottom"><span>OpenRouter + Browserless</span><span>Isolated execution · 15s limit</span></div></section>
    </div>
    {resultError && <Notice>{resultError}{job?.endpointId && <Link href={`/dashboard/scrapers/${encodeURIComponent(job.endpointId)}/docs`}>Open endpoint documentation</Link>}</Notice>}
    {job?.status === 'succeeded' && !result && !resultError && <div className="dash-panel scraper-result-loading"><Spinner label="Loading your verified endpoint"/></div>}
    {result && <section className="dash-panel scraper-result"><div className="scraper-result-heading"><span className="scraper-icon mint"><Check size={21}/></span><div><span className="scraper-overline">READY TO CONNECT</span><h2>{result.name}</h2><p>Your verified scraper is now a reusable API.</p></div><Link className="dash-button primary" href={`/dashboard/scrapers/${encodeURIComponent(result.id)}/docs`}>Interactive docs<ArrowUpRight size={15}/></Link></div><div className="scraper-result-grid"><div><label className="scraper-output-label">Endpoint URL</label><div className="scraper-copy-field"><span className="scraper-method">GET</span><code>{result.endpointUrl}</code><CopyButton value={result.endpointUrl}/></div><label className="scraper-output-label">Endpoint API key</label>{apiKey ? <><div className="scraper-copy-field"><KeyRound size={16}/><input aria-label="Generated endpoint API key" type={showKey ? 'text' : 'password'} readOnly value={apiKey} autoComplete="off" spellCheck={false}/><button className="dash-icon-button" aria-label={showKey ? 'Hide API key' : 'Show API key'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16}/> : <Eye size={16}/>}</button><CopyButton value={apiKey}/></div><p className="scraper-key-note">Save this key now. It is shown once and is never stored in your browser.</p></> : <div className="scraper-reveal"><div><KeyRound size={17}/><span>Reveal and save your endpoint’s secret key.</span></div><button className="dash-button" disabled={revealing} onClick={() => void revealKey()}>{revealing ? <Spinner label="Revealing"/> : <><Eye size={15}/>Reveal API key</>}</button></div>}{keyError && <p className="scraper-inline-error" role="alert">{keyError}</p>}<div className="scraper-curl"><div><span>Quick request</span><CopyButton value={scraperCurl(result.id)} label="Copy cURL"/></div><pre><code>{scraperCurl(result.id)}</code></pre></div></div><div className="scraper-output-preview"><div className="scraper-preview-tabs"><button className={resultTab === 'sample' ? 'is-active' : ''} aria-pressed={resultTab === 'sample'} onClick={() => setResultTab('sample')}><Braces size={14}/>Verified output</button><button className={resultTab === 'code' ? 'is-active' : ''} aria-pressed={resultTab === 'code'} onClick={() => setResultTab('code')}><Code2 size={14}/>Scraper code</button></div><pre><code>{resultTab === 'sample' ? JSON.stringify(result.sample, null, 2) : result.code}</code></pre></div></div></section>}
    <section className="scraper-directory"><div className="scraper-directory-heading"><div><h2>Your scraper endpoints<span>{directory?.endpoints.length ?? '—'}</span></h2><p>Manage the websites you’ve turned into APIs.</p></div><button className="dash-button" disabled={refreshing} onClick={() => void load()}><RefreshCw size={14} className={refreshing ? 'dash-spin' : ''}/>Refresh</button></div>{!directory ? <div className="dash-panel scraper-result-loading"><Spinner label="Loading scraper endpoints"/></div> : !directory.endpoints.length ? <div className="dash-panel"><EmptyState icon={<ScanSearch size={25}/>} title="Your first website-powered API." description="Create an endpoint above. Its documentation and controls will live here."/></div> : <div className="scraper-endpoint-list">{directory.endpoints.map(endpoint => <article className="dash-panel scraper-endpoint" key={endpoint.id}><span className="scraper-icon violet"><Globe2 size={20}/></span><div className="scraper-endpoint-info"><h3>{endpoint.name}<span className={endpoint.enabled ? 'scraper-status enabled' : 'scraper-status'}>{endpoint.enabled ? 'Live' : 'Paused'}</span></h3><p>{endpoint.description}</p><div><code>{scraperEndpointPath(endpoint.id)}</code><span><Clock3 size={12}/>{scraperCacheLabel(endpoint.cacheTtlSeconds)}</span><span>Created {formatDate(endpoint.createdAt)}</span></div></div><div className="scraper-endpoint-actions"><button type="button" className="scraper-enable" role="switch" aria-checked={endpoint.enabled} aria-label={`${endpoint.enabled ? 'Pause' : 'Enable'} ${endpoint.name}`} disabled={busyEndpoint === endpoint.id} onClick={() => void toggle(endpoint)}><span/></button><Link className="dash-button" href={`/dashboard/scrapers/${encodeURIComponent(endpoint.id)}/docs`}><FileJson2 size={14}/>Docs<ArrowUpRight size={12}/></Link><button className="dash-icon-button" aria-label={`Delete ${endpoint.name}`} disabled={Boolean(busyEndpoint)} onClick={() => setDeleting(endpoint)}><Trash2 size={16}/></button></div></article>)}</div>}</section>
    <div className="scraper-bottom-note"><ShieldCheck size={15}/><p>Relay validates public destinations, tests the generated extraction, and protects every endpoint with its own API key.</p><Link href="/dashboard/keys">Gateway access<ArrowRight size={13}/></Link></div>
    {deleting && <Modal title={`Delete ${deleting.name}?`} description="This removes the scraper endpoint and revokes its access." onClose={() => { if (!busyEndpoint) setDeleting(null); }}><p className="dash-dialog-copy">Existing applications calling this API will stop receiving results. This action cannot be undone.</p><div className="dash-dialog-actions"><button className="dash-button" disabled={Boolean(busyEndpoint)} onClick={() => setDeleting(null)}>Keep endpoint</button><button className="dash-button destructive" disabled={Boolean(busyEndpoint)} onClick={() => void remove()}>{busyEndpoint ? <Spinner label="Deleting"/> : <><Trash2 size={14}/>Delete endpoint</>}</button></div></Modal>}
  </div>;
}
