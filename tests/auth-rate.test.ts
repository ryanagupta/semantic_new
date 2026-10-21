import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Request, RequestHandler, Response } from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

process.env.DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'nexus-auth-rate-')),'test.db');
process.env.NODE_ENV='test';
process.env.JWT_ISSUER='https://issuer.example.test';
process.env.JWT_AUDIENCE='nexus-test-gateway';
delete process.env.REDIS_URL;
const {publicKey,privateKey}=await generateKeyPair('RS256');
const jwk={...await exportJWK(publicKey),kid:'test-key',alg:'RS256',use:'sig'};
const jwks=createServer((_request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({keys:[jwk]}));});
await new Promise<void>(resolve=>jwks.listen(0,'127.0.0.1',resolve));
const address=jwks.address();assert(address&&typeof address!=='string');
process.env.JWT_JWKS_URL=`http://127.0.0.1:${address.port}/jwks`;
const {authenticateToken,requireKey}=await import('../server/auth.js');
const {consumePrincipalRate,consumePreAuthenticationRate,globalProtection,tokenProtection}=await import('../server/middleware/security.js');
const {SlidingWindowLimiter,RateLimitError}=await import('../server/limiter.js');
const {HttpError}=await import('../server/errors.js');
const {store}=await import('../server/store.js');
const {billingStore}=await import('../server/billing/store.js');
const {authorizeExecution,chargeExecution}=await import('../server/execution.js');
const {CircuitBreaker,CircuitOpenError,circuitBreakers}=await import('../server/gateway/circuit-breaker.js');

after(async()=>{store.close();billingStore.close();jwks.closeAllConnections();await new Promise<void>(resolve=>jwks.close(()=>resolve()));});

function bearer(token:string,ip=randomUUID()):Request{return {headers:{authorization:`Bearer ${token}`},ip,socket:{}} as Request;}
async function middleware(handler:RequestHandler,request:Request){
  const headers:Record<string,unknown>={};
  const response={setHeader:(name:string,value:unknown)=>{headers[name]=value;}} as unknown as Response;
  await new Promise<void>((resolve,reject)=>{Promise.resolve(handler(request,response,error=>error?reject(error):resolve())).catch(reject);});
  return headers;
}
async function jwt(subject:string,options:{expires?:boolean;issuer?:string;audience?:string}={}){
  let token=new SignJWT({scope:'tools:read tools:call'}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setSubject(subject).setIssuer(options.issuer??process.env.JWT_ISSUER!).setAudience(options.audience??process.env.JWT_AUDIENCE!).setJti(randomUUID()).setIssuedAt();
  if(options.expires!==false)token=token.setExpirationTime('5m');
  return token.sign(privateKey);
}
const unauthorized=(error:unknown)=>error instanceof HttpError&&error.status===401;

test('JWT validation binds issuer, audience, subject and expiration; rotating tokens share a principal budget',async()=>{
  const subject=randomUUID(),first=await jwt(subject),second=await jwt(subject);
  assert.notEqual(first,second);
  const a=await authenticateToken(first),b=await authenticateToken(second);
  assert.equal(a.id,b.id);assert.equal(a.rateKey,b.rateKey);assert.match(a.rateKey!,/^[a-f0-9]{64}$/);
  for(const token of [await jwt(subject,{expires:false}),await jwt(subject,{issuer:'https://attacker.test'}),await jwt(subject,{audience:'other-gateway'})])await assert.rejects(()=>authenticateToken(token),unauthorized);
  const results=await Promise.allSettled(Array.from({length:65},(_,index)=>consumePrincipalRate(index%2?a:b)));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,60);
  assert(results.filter(result=>result.status==='rejected').every(result=>result.status==='rejected'&&result.reason instanceof RateLimitError));
});

test('A valid JWT receives the authenticated IP tier while unknown credentials remain at the anonymous tier',async()=>{
  const token=await jwt(randomUUID()),ip=randomUUID();
  for(let index=0;index<65;index++)assert.equal((await middleware(globalProtection,bearer(token,ip)))['X-RateLimit-Limit'],3000);
  const anonymousIp=randomUUID();
  for(let index=0;index<60;index++)assert.equal((await middleware(globalProtection,bearer('invalid-jwt',anonymousIp)))['X-RateLimit-Limit'],60);
  await assert.rejects(()=>middleware(globalProtection,bearer('invalid-jwt',anonymousIp)),error=>error instanceof RateLimitError&&error.rate.limit===60);
});

test('The coarse IP guard rejects exhausted clients before reading credentials or performing JWT verification',async()=>{
  const ip=randomUUID();
  for(let index=0;index<3000;index++)await consumePreAuthenticationRate(ip);
  let credentialReads=0;
  const headers=Object.defineProperty({},'authorization',{get(){credentialReads++;throw new Error('Credentials should not be parsed');}});
  await assert.rejects(()=>middleware(globalProtection,{headers,ip,socket:{}} as Request),error=>error instanceof RateLimitError&&error.rate.limit===3000);
  assert.equal(credentialReads,0);
});

test('API key rate budgets use the credential hash, are shared across HTTP and transport helpers, and survive key revocation checks',async()=>{
  const {key,secret}=store.createKey('Rate integration',['tools:call'],2);
  const principal=await authenticateToken(secret);
  assert.equal(principal.rateKey,createHash('sha256').update(secret).digest('hex'));
  const request=bearer(secret);
  await middleware(requireKey,request);
  const headers=await middleware(tokenProtection,request);
  assert.equal(headers['X-RateLimit-Limit'],2);assert.equal(headers['X-RateLimit-Remaining'],1);
  assert.equal((await consumePrincipalRate(principal)).remaining,0);
  await assert.rejects(()=>middleware(tokenProtection,request),error=>error instanceof RateLimitError&&error.rate.limit===2);
  assert(store.revokeKey(key.id));
  await assert.rejects(()=>authenticateToken(secret),unauthorized);
  const endpoint={id:'test',name:'get_value',description:'',url:'https://example.com',method:'GET' as const,enabled:true,inputSchema:{type:'object'},parameters:[],createdAt:'',updatedAt:''};
  assert.throws(()=>authorizeExecution(endpoint,principal),unauthorized);
});

test('Resource scope cannot invoke a GET tool or a reverse route; resource reads still require a GET endpoint',()=>{
  const principal={id:`jwt:${randomUUID()}`,scopes:['resources:read'],rateLimit:60};
  const endpoint={id:randomUUID(),name:'get_value',description:'',url:'https://example.com',method:'GET' as const,enabled:true,inputSchema:{type:'object'},parameters:[],createdAt:'',updatedAt:''};
  const forbidden=(error:unknown)=>error instanceof HttpError&&error.status===403;
  assert.throws(()=>authorizeExecution(endpoint,principal),forbidden);
  assert.doesNotThrow(()=>authorizeExecution(endpoint,principal,'resource'));
  assert.throws(()=>authorizeExecution({...endpoint,method:'POST'},principal,'resource'),forbidden);
  assert.throws(()=>authorizeExecution({...endpoint,enabled:false},principal,'resource'),error=>error instanceof HttpError&&error.status===404);
});

test('Open circuits reject before quota debit; half-open reservations bound concurrent charged requests and release cancelled probes',async()=>{
  let clock=1_000_000;
  const endpoint=store.saveEndpoint({name:'circuit_'+randomUUID().replaceAll('-',''),description:'',url:'https://example.com',method:'GET',enabled:true,inputSchema:{type:'object',properties:{}},parameters:[]});
  const breaker=new CircuitBreaker(endpoint.id,()=>clock);circuitBreakers.set(endpoint.id,breaker);
  for(let index=0;index<5;index++)breaker.acquire()(true);
  const principal={id:'dashboard',scopes:['admin'],rateLimit:300};
  const before=billingStore.snapshot().used;
  await assert.rejects(()=>chargeExecution(endpoint,principal),error=>error instanceof CircuitOpenError);
  assert.equal(billingStore.snapshot().used,before);
  clock+=15_001;
  const results=await Promise.allSettled(Array.from({length:6},()=>chargeExecution(endpoint,principal)));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,5);
  assert.equal(billingStore.snapshot().used,before+5);
  for(const result of results)if(result.status==='fulfilled')result.value(null);
  const probes=Array.from({length:5},()=>breaker.acquire());
  assert.throws(()=>breaker.acquire(),error=>error instanceof CircuitOpenError);
  for(const finish of probes)finish(null);
  assert.equal(breaker.state,'HALF_OPEN');
  assert.doesNotThrow(()=>breaker.acquire()(null));
  circuitBreakers.delete(endpoint.id);store.deleteEndpoint(endpoint.id);
});

test('Memory limiter cleanup preserves long authentication windows and invalid configuration fails closed',async()=>{
  let clock=0;const limiter=new SlidingWindowLimiter(()=>clock);
  await limiter.consume('login',1,300_000);
  for(let index=0;index<10_001;index++)await limiter.consume(`short:${index}`,1,60_000);
  clock=61_000;await limiter.consume('cleanup',1,60_000);
  await assert.rejects(()=>limiter.consume('login',1,300_000),error=>error instanceof RateLimitError);
  await assert.rejects(()=>limiter.consume('login',1,1000),error=>error instanceof RateLimitError);
  clock=300_001;assert.equal((await limiter.consume('login',1,300_000)).remaining,0);
  for(const limit of [NaN,Infinity,0,-1,1.5])await assert.rejects(()=>limiter.consume('invalid',limit),error=>error instanceof HttpError&&error.status===503);
  await assert.rejects(()=>limiter.consume('invalid',1,NaN),error=>error instanceof HttpError&&error.status===503);
});
