'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export function CopyButton({ value, label = 'Copy code' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try { await navigator.clipboard.writeText(value); setState('copied'); } catch { setState('failed'); }
    window.setTimeout(() => setState('idle'), 2000);
  }
  return <button type="button" className="copy-button" onClick={copy} aria-label={state === 'copied' ? 'Copied' : label} title={state === 'failed' ? 'Clipboard unavailable. Select and copy the code.' : label}>{state === 'copied' ? <Check size={14} /> : <Copy size={14} />}<span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Select to copy' : 'Copy'}</span></button>;
}
