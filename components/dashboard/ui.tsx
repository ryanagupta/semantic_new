'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, LoaderCircle, X } from 'lucide-react';

export function PageHeader({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <div className="dash-page-heading"><div><div className="dash-eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="dash-heading-actions">{children}</div></div>;
}

export function Notice({ children, success = false }: { children: ReactNode; success?: boolean }) {
  return <div role={success ? 'status' : 'alert'} className={`dash-notice ${success ? 'success' : ''}`}>{children}</div>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) { return <span className="dash-loading"><LoaderCircle size={16} className="dash-spin" />{label}</span>; }

export function EmptyState({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children?: ReactNode }) {
  return <div className="dash-empty"><div className="dash-empty-icon">{icon}</div><h3>{title}</h3><p>{description}</p>{children}</div>;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <button type="button" className="dash-button subtle" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setError(false); timer.current = setTimeout(() => setCopied(false), 1800); } catch { setError(true); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}{error ? 'Select and copy manually' : copied ? 'Copied' : label}</button>;
}

export function Modal({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const close = () => onClose();
    element?.addEventListener('cancel', close);
    return () => element?.removeEventListener('cancel', close);
  }, [onClose]);
  return <dialog ref={dialog} className="dash-dialog" aria-label={title} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="dash-dialog-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button type="button" className="dash-icon-button" onClick={onClose} aria-label="Close dialog"><X size={19} /></button></div>{children}</dialog>;
}

export function formatNumber(value: number) { return new Intl.NumberFormat('en', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value); }
export function formatDate(value: string | null) { return value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never'; }
