'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Eye, EyeOff, Github, LoaderCircle, Mail } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { relayAuthProviders, type RelayAuthProvider } from '@/config/auth-providers';
import { authClient } from '@/lib/auth-client';
import { RelayBrand } from './brand';
import './auth-screen.css';

function ProviderIcon({ provider }: { provider: RelayAuthProvider }) {
  if (provider === 'github') return <Github size={21} fill="currentColor" strokeWidth={1.2} aria-hidden="true"/>;
  if (provider === 'twitter') return <svg viewBox="0 0 24 24" width="21" height="21" fill="none" aria-hidden="true"><path d="M4 3h4l12 18h-4L4 3Z" stroke="currentColor" strokeWidth="1.6"/><path d="M20 3 4 21" stroke="currentColor" strokeWidth="1.6"/></svg>;
  if (provider === 'apple') return <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M16.4 1.5c.1 1.2-.4 2.4-1.1 3.2-.8.9-2 1.6-3.2 1.5-.2-1.2.4-2.4 1.1-3.2.8-.9 2-1.5 3.2-1.5ZM20.6 17.4c-.5 1.1-.8 1.6-1.5 2.6-.9 1.3-2.1 2.9-3.6 2.9-1.3 0-1.6-.9-3.4-.9s-2.1.9-3.4 1c-1.5 0-2.6-1.5-3.5-2.8C2.7 16.6 2 12 3.6 9.5c1.1-1.8 2.8-2.8 4.5-2.8 1.5 0 2.5.9 3.8.9 1.2 0 2-.9 3.8-.9 1.5 0 3.1.8 4.2 2.1-3.7 2-3.1 7.2.7 8.6Z"/></svg>;
  if (provider !== 'google') return <span className="relay-auth-provider-monogram" aria-hidden="true">{relayAuthProviders.find(item => item.id === provider)?.name.slice(0, 1)}</span>;
  return <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.04.97-3.38.97-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.41 13.93a6 6 0 0 1 0-3.86V7.48H3.07a10 10 0 0 0 0 9.04l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.95c1.47 0 2.78.5 3.82 1.5l2.86-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.48l3.34 2.59C7.2 7.71 9.4 5.95 12 5.95Z"/></svg>;
}

export function AuthForm({ mode, next = '/dashboard', providers = [], initialError = '' }: { mode: 'login' | 'signup'; next?: string; providers?: RelayAuthProvider[]; initialError?: string }) {
  const router = useRouter();
  const signup = mode === 'signup';
  const [step, setStep] = useState<'methods' | 'email' | 'password'>('methods');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const firstInput = useRef<HTMLInputElement>(null);
  const shownProviders = relayAuthProviders.slice(0, 4);
  const alternate = `${signup ? '/login' : '/signup'}${next !== '/dashboard' ? `?next=${encodeURIComponent(next)}` : ''}`;

  useEffect(() => { if (step !== 'methods') firstInput.current?.focus(); }, [step]);

  function goBack() {
    if (busy) return;
    setError(''); setPassword(''); setVisible(false);
    setStep(step === 'password' ? 'email' : 'methods');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (step === 'email') { setEmail(email.trim()); setStep('password'); return; }
    if (signup && !name.trim()) { setError('Please enter your name.'); firstInput.current?.focus(); return; }
    setBusy(true);
    try {
      const result = signup ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password }) : await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) { setError(result.error.message || 'We couldn’t sign you in. Please try again.'); return; }
      router.replace(next); router.refresh();
    } catch { setError('Unable to reach Relay. Please try again.'); }
    finally { setBusy(false); }
  }

  async function social(provider: RelayAuthProvider) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await authClient.signIn.social({ provider, callbackURL: next, errorCallbackURL: `${mode === 'login' ? '/login' : '/signup'}?error=oauth&next=${encodeURIComponent(next)}` });
      if (result.error) setError(result.error.message || 'Unable to connect. Please try another sign-in method.');
    } catch { setError('Unable to reach the sign-in provider. Please try again.'); }
    finally { setBusy(false); }
  }

  const heading = step === 'methods' ? signup ? 'Create your account' : 'Log into your account' : step === 'email' ? signup ? 'Sign up with your email' : 'Log in with your email' : signup ? 'Make yourself at home' : 'Enter your password';

  return <div className="relay-auth-screen">
    <header className="relay-auth-header"><RelayBrand compact/><div className="relay-auth-destination"><span>You are {signup ? 'signing up' : 'signing into'}</span><span className="relay-auth-destination-pill">Relay</span></div></header>
    <main className="relay-auth-main" id="main"><section className="relay-auth-card" aria-labelledby="relay-auth-heading" data-step={step}>
      <h1 id="relay-auth-heading">{heading}</h1>
      {step === 'methods' ? <div className="relay-auth-stage" key="methods">
        {error && <p className="relay-auth-error" role="alert">{error}</p>}
        <div className="relay-auth-methods">{shownProviders.map(provider => <button key={provider.id} type="button" className="relay-auth-pill" disabled={busy || !providers.includes(provider.id)} title={providers.includes(provider.id) ? undefined : `${provider.name} sign-in is not connected yet`} onClick={() => social(provider.id)}><ProviderIcon provider={provider.id}/><span>{signup ? 'Sign up' : 'Log in'} with {provider.name}</span></button>)}
          <div className="relay-auth-divider"><span>or</span></div><button type="button" className="relay-auth-pill relay-auth-pill-primary" disabled={busy} onClick={() => { setError(''); setStep('email'); }}><Mail size={21} strokeWidth={1.5}/>{signup ? 'Sign up' : 'Log in'} with email</button>
        </div>
        {providers.length === 0 && <p className="relay-auth-provider-help">Social sign-in is not connected yet.</p>}
      </div> : <form onSubmit={submit} className="relay-auth-stage" key={step}>
        <fieldset disabled={busy}>
          {step === 'email' ? <label htmlFor="relay-auth-email">Email<input ref={firstInput} id="relay-auth-email" name="email" type="email" required maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={event => setEmail(event.target.value)}/></label> : <><div className="relay-auth-email-chip"><Mail size={14}/><span>{email}</span><button type="button" onClick={goBack}>Change</button></div><input type="hidden" name="email" value={email} autoComplete="username"/>{signup && <label htmlFor="relay-auth-name">Your name<input ref={firstInput} id="relay-auth-name" name="name" type="text" required maxLength={100} autoComplete="name" value={name} onChange={event => setName(event.target.value)}/></label>}<label htmlFor="relay-auth-password">Password<div className="relay-auth-password"><input ref={signup ? undefined : firstInput} id="relay-auth-password" name="password" type={visible ? 'text' : 'password'} required minLength={signup ? 12 : 1} maxLength={128} autoComplete={signup ? 'new-password' : 'current-password'} aria-describedby={signup ? 'relay-password-help' : undefined} value={password} onChange={event => setPassword(event.target.value)}/><button type="button" aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div></label>{signup && <p id="relay-password-help" className="relay-auth-input-help">Use at least 12 characters.</p>}</>}
          {error && <p className="relay-auth-error" role="alert">{error}</p>}
          <button type="submit" className="relay-auth-pill relay-auth-pill-primary">{busy ? <><LoaderCircle size={17} className="relay-spin"/>{signup ? 'Creating your account…' : 'Signing in…'}</> : step === 'email' ? 'Next' : signup ? 'Create account' : 'Log in'}</button>
          <button type="button" className="relay-auth-pill relay-auth-go-back" onClick={goBack}><ArrowLeft size={15}/>Go back</button>
        </fieldset>
      </form>}
      <p className="relay-auth-account-switch">{signup ? 'Already have an account?' : 'Don’t have an account?'} <Link href={alternate}>{signup ? 'Sign in' : 'Sign up'}</Link></p>
    </section></main>
    <footer className="relay-auth-page-footer"><Link href="/docs#security">Privacy & security</Link><span>© {new Date().getUTCFullYear()} Relay</span><Link href="/">Back to Relay</Link></footer>
  </div>;
}
