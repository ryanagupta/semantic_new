import { createHash } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import { limiter, type RateState } from '../limiter.js';
import { authenticateRequest, hasSession, type AuthedRequest } from '../auth.js';
import type { Principal } from '../../shared/types.js';
import { billingStore } from '../billing/store.js';
import { HttpError } from '../errors.js';
import { getEnterpriseBurst } from '../enterprise.js';

export const principalRateKey=(principal:Principal):string=>principal.rateKey??createHash('sha256').update(principal.id).digest('hex');
export async function consumePrincipalRate(principal:Principal):Promise<RateState>{
  const plan=billingStore.snapshot();
  const burst=plan.tier==='enterprise'?(await getEnterpriseBurst()).requests:0;
  return limiter.consume(`key:${principalRateKey(principal)}`,Math.min(principal.rateLimit,plan.maxRateLimit)+burst);
}
export async function consumeToolRate(principal:Principal):Promise<RateState>{
  const plan=billingStore.snapshot(),burst=plan.tier==='enterprise'?(await getEnterpriseBurst()).tools:0;
  return limiter.consume(`tools:${principalRateKey(principal)}`,plan.toolRateLimit+burst);
}
export async function consumePreAuthenticationRate(ip:string):Promise<RateState>{
  const plan=billingStore.snapshot(),burst=plan.tier==='enterprise'?(await getEnterpriseBurst()).requests:0;
  return limiter.consume(`ip:pre:${ip}`,Math.max(3000,plan.maxRateLimit+burst));
}
export async function consumeClassifiedIpRate(ip:string,authenticated:boolean):Promise<RateState>{
  const plan=billingStore.snapshot(),burst=authenticated&&plan.tier==='enterprise'?(await getEnterpriseBurst()).requests:0;
  return limiter.consume(`ip:${ip}`,authenticated?Math.max(3000,plan.maxRateLimit+burst):60);
}

export function rateHeaders(res:Response,rate:RateState){
  res.setHeader('X-RateLimit-Limit',rate.limit);res.setHeader('X-RateLimit-Remaining',rate.remaining);res.setHeader('X-RateLimit-Reset',rate.reset);
  if(rate.remaining===0)res.setHeader('Retry-After',Math.max(1,rate.reset-Math.floor(Date.now()/1000)));
}
export const globalProtection:RequestHandler=async(req,res,next)=>{
  try {
    const ip=req.ip??req.socket.remoteAddress??'unknown';
    await consumePreAuthenticationRate(ip);
    let known:Principal|undefined;
    try{known=await authenticateRequest(req);}catch(error){if(!(error instanceof HttpError&&error.status===401))throw error;}
    if(!known&&req.path?.startsWith('/api/scrapers')&&await hasSession(req))known={id:'scraper-console',scopes:['admin'],rateLimit:300};
    const rate=await consumeClassifiedIpRate(ip,!!known);
    rateHeaders(res,rate);next();
  }catch(e){next(e);}
};
export const tokenProtection:RequestHandler=async(req,res,next)=>{
  try{
    const principal=(req as AuthedRequest).nexusPrincipal;
    const rate=await consumePrincipalRate(principal);
    rateHeaders(res,rate);next();
  }catch(e){next(e);}
};
