const sensitive=/authorization|x-api-key|bearer|password|secret|token|cookie|^(?:code|state|code_verifier)$/i;
export function maskText(value:string):string {
  return value
    .replace(/\b(?:\d[ -]*?){13,19}\b/g,'[REDACTED_CARD]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g,'[REDACTED_SSN]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED_JWT]')
    .replace(/\b(?:sk_live_|sk_test_|nx_live_)[A-Za-z0-9_-]+/g,'[REDACTED_KEY]')
    .replace(/\b(Bearer\s+)\S+/gi,'$1[REDACTED]')
    .replace(/([?&](?:[^=&]*(?:token|key|password|secret|authorization)[^=&]*|code|state|code_verifier)=)[^&\s]*/gi,'$1[REDACTED]');
}
export function redact(value:unknown,depth=0):unknown {
  if(depth>12) return '[TRUNCATED]';
  if(typeof value==='string')return maskText(value).slice(0,4000);
  if(Array.isArray(value))return value.slice(0,100).map(v=>redact(v,depth+1));
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,100).map(([k,v])=>[k,sensitive.test(k)?'[REDACTED]':redact(v,depth+1)]));
  return value;
}
export function audit(event:string,data:unknown) { process.stderr.write(JSON.stringify({time:new Date().toISOString(),event,data:redact(data)})+'\n'); }
