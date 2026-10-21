import { z } from 'zod';
import { limiter } from './limiter.js';
import { HttpError } from './errors.js';
import { billingStore } from './billing/store.js';

const key='nexus:workspace:default:enterprise-burst';
export const burstSchema=z.object({requests:z.number().int().min(0).max(100000),tools:z.number().int().min(0).max(10000),durationSeconds:z.number().int().min(10).max(300)}).strict();
export interface EnterpriseBurst {requests:number;tools:number;expiresAt:number;}
export async function getEnterpriseBurst():Promise<EnterpriseBurst>{
  const none={requests:0,tools:0,expiresAt:0};
  if(billingStore.snapshot().tier!=='enterprise')return none;
  const redis=limiter.client;if(!redis)return none;
  if(!redis.isReady)throw new HttpError(503,'Enterprise burst allocation service unavailable');
  const raw=await redis.get(key);if(!raw)return none;
  const value=z.object({requests:z.number().int().min(0).max(100000),tools:z.number().int().min(0).max(10000),expiresAt:z.number().int()}).parse(JSON.parse(raw));
  return value.expiresAt>Date.now()?value:none;
}
export async function allocateEnterpriseBurst(input:unknown){
  if(billingStore.snapshot().tier!=='enterprise')throw new HttpError(403,'Enterprise policy is available only to provisioned Enterprise workspaces');
  const policy=burstSchema.parse(input),redis=limiter.client;
  if(!redis?.isReady)throw new HttpError(503,'Redis is required for dynamic burst allocation');
  const allocation={requests:policy.requests,tools:policy.tools,expiresAt:Date.now()+policy.durationSeconds*1000};
  await redis.set(key,JSON.stringify(allocation),{EX:policy.durationSeconds});return allocation;
}
