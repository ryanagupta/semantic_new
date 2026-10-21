import { AsyncLocalStorage } from 'node:async_hooks';
import type { Response } from 'express';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Endpoint, Principal, UpstreamResult } from '../shared/types.js';
import { store } from './store.js';
import { billingStore } from './billing/store.js';
import { HttpError } from './errors.js';
import { consumeQuota } from './middleware/quotas.js';
import { consumeToolRate, rateHeaders } from './middleware/security.js';
import { sanitizeArguments } from './mcp/guardrails.js';
import { acquireCircuit, type CircuitCompletion } from './gateway/circuit-breaker.js';
import { executeUpstream } from './upstream.js';
import { maskText } from './telemetry/logger.js';
import { scraperStore } from './scraper/store.js';
import { executeGeneratedScraper } from './scraper/execution.js';

interface ExecutionContext {response:Response;charged?:string;reservation?:CircuitCompletion;preparedRemote?:{name:string;result:CallToolResult};}
export type ExecutionPurpose='tool'|'resource';
export const requestContext=new AsyncLocalStorage<ExecutionContext>();
export function authorizeExecution(endpoint:Endpoint,principal:Principal,purpose:ExecutionPurpose='tool'){
  if(principal.id!=='dashboard'&&!principal.id.startsWith('jwt:')&&!store.isKeyActive(principal.id))throw new HttpError(401,'API key revoked');
  const accepted=['*','admin','tools:*','tools:call',`tool:${endpoint.name}`];
  if(purpose==='resource'&&endpoint.method==='GET')accepted.push('resources:read');
  if(!principal.scopes.some(scope=>accepted.includes(scope)))throw new HttpError(403,'API key does not have permission for this tool');
  if(!endpoint.enabled)throw new HttpError(404,'Endpoint is disabled');
}
export async function chargeExecution(endpoint:Endpoint,principal:Principal,purpose:ExecutionPurpose='tool'):Promise<CircuitCompletion>{
  authorizeExecution(endpoint,principal,purpose);
  const reservation=acquireCircuit(endpoint.id);
  try{
    const rate=await consumeToolRate(principal);
    const context=requestContext.getStore();if(context&&!context.response.headersSent)rateHeaders(context.response,rate);
    const quota=await consumeQuota();
    if(context){
      context.charged=endpoint.id;context.reservation=reservation;
      context.response.once('finish',()=>{if(context.reservation===reservation){reservation(null);context.reservation=undefined;}});
      context.response.once('close',()=>{if(context.reservation===reservation){reservation(null);context.reservation=undefined;}});
      if(!context.response.headersSent&&quota.used>=(quota.monthlyLimit+quota.credits)*.8)context.response.setHeader('X-Nexus-Quota-Warning','80%');
    }
    return reservation;
  }catch(error){reservation(null);throw error;}
}
function upstreamTokens(body:string){
  try{const data=JSON.parse(body),usage=data?.usage;const count=usage?.total_tokens??((usage?.input_tokens??0)+(usage?.output_tokens??0));return typeof count==='number'&&Number.isSafeInteger(count)&&count>0?count:0;}catch{return 0;}
}
export async function executeEndpoint(input:Endpoint,args:Record<string,unknown>,principal:Principal,purpose:ExecutionPurpose='tool'):Promise<UpstreamResult>{
  const endpoint=store.getEndpoint(input.id);if(!endpoint)throw new HttpError(404,'Endpoint no longer exists');
  const started=performance.now();let status=500,error:string|null=null,tokens=0;
  try{
    authorizeExecution(endpoint,principal,purpose);
    const clean=sanitizeArguments(endpoint,args);
    const context=requestContext.getStore();
    const reservation=context?.charged===endpoint.id&&context.reservation?context.reservation:await chargeExecution(endpoint,principal,purpose);
    if(context){context.reservation=undefined;context.charged=undefined;}
    const generated=scraperStore.get(endpoint.id);
    const result=generated?await executeGeneratedScraper(generated,reservation):await executeUpstream(endpoint,clean,reservation);status=result.status;tokens=upstreamTokens(result.body);return result;
  }catch(e){status=typeof (e as {status?:unknown})?.status==='number'?(e as {status:number}).status:502;error=maskText(e instanceof Error?e.message:'Upstream execution failed');throw e;}
  finally{store.log({endpointId:endpoint.id,tool:endpoint.name,method:endpoint.method,status,latency:performance.now()-started,tokens,keyId:principal.id,error});}
}
