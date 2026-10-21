import { createHash, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import type { Request, RequestHandler, Response } from 'express';
import type { Principal } from '../shared/types.js';
import { config } from './config.js';
import { store } from './store.js';
import { HttpError } from './errors.js';
import { limiter } from './limiter.js';

const secret=new TextEncoder().encode(config.sessionSecret);
const cookieName='nexus_session';
const cookieOptions={httpOnly:true,secure:config.production,sameSite:'strict' as const,path:'/',maxAge:8*3600000};
const jwks=config.JWT_JWKS_URL ? createRemoteJWKSet(new URL(config.JWT_JWKS_URL)):undefined;
export type AuthedRequest=Request & {nexusPrincipal:Principal};
const requestCredentials = new WeakMap<Request, { token: string; principal: Principal }>();
function cookie(req: Request) {
  return req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
}
export async function hasSession(req: Request) {
  const token=cookie(req); if(!token) return false;
  try { await jwtVerify(token,secret,{issuer:'nexus-dashboard',audience:'nexus-admin',algorithms:['HS256']}); return true; } catch { return false; }
}
export async function setSession(res: Response) {
  const token=await new SignJWT({role:'admin'}).setProtectedHeader({alg:'HS256'}).setIssuer('nexus-dashboard').setAudience('nexus-admin').setSubject('workspace-owner').setIssuedAt().setExpirationTime('8h').sign(secret);
  res.cookie(cookieName,token,cookieOptions);
}
export function clearSession(res:Response){res.clearCookie(cookieName,{...cookieOptions,maxAge:undefined});}
export function passwordMatches(value:string){return timingSafeEqual(createHash('sha256').update(value).digest(),createHash('sha256').update(config.dashboardPassword).digest());}
export const requireAdmin: RequestHandler=async(req,res,next)=>{
  try { if(!await hasSession(req)) throw new HttpError(401,'Sign in to your workspace'); (req as AuthedRequest).nexusPrincipal={id:'dashboard',scopes:['admin'],rateLimit:300}; next(); }catch(e){next(e);}
};
export const checkOrigin:RequestHandler=(req,_res,next)=>{
  const origin=req.headers.origin;
  if(origin && origin!==new URL(config.APP_ORIGIN).origin) return next(new HttpError(403,'Origin is not allowed'));
  if(req.path.startsWith('/api/') && !['GET','HEAD','OPTIONS'].includes(req.method) && req.headers['sec-fetch-site']==='cross-site') return next(new HttpError(403,'Cross-site request rejected'));
  next();
};
export async function authenticateToken(token:string): Promise<Principal> {
  if(token.length>16384)throw new HttpError(401,'Bearer token is too large');
  if(token.startsWith('nx_live_')) { const principal=store.authenticateKey(token); if(principal) return principal; }
  else if(jwks && config.JWT_ISSUER && config.JWT_AUDIENCE) {
    try { const {payload}=await jwtVerify(token,jwks,{issuer:config.JWT_ISSUER,audience:config.JWT_AUDIENCE,algorithms:['RS256','ES256'],requiredClaims:['sub','exp']});
      if(!payload.sub || payload.sub.length>512) throw new Error('Invalid subject');
      const scopes=typeof payload.scope==='string'?payload.scope.split(' ').filter(Boolean):[];
      return {id:`jwt:${payload.sub}`,scopes,rateLimit:60,rateKey:createHash('sha256').update(`jwt:${config.JWT_ISSUER}\0${payload.sub}`).digest('hex')};
    }catch{throw new HttpError(401,'Invalid or expired bearer token');}
  }
  throw new HttpError(401,'Invalid or revoked API key');
}
export async function authenticateRequest(req:Request):Promise<Principal|undefined>{
  const bearer=req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]??(req.path?.startsWith('/api/v1/custom/')&&typeof req.headers['x-api-key']==='string'?req.headers['x-api-key']:undefined);
  if(!bearer)return;
  const cached=requestCredentials.get(req);
  if(cached?.token===bearer)return cached.principal;
  const principal=await authenticateToken(bearer);
  requestCredentials.set(req,{token:bearer,principal});
  return principal;
}
export const requireKey:RequestHandler=async(req,res,next)=>{
  try {
    const principal=await authenticateRequest(req);
    if(!principal) throw new HttpError(401,'Provide Authorization: Bearer <API key>');
    (req as AuthedRequest).nexusPrincipal=principal; next();
  }catch(e){ if(e instanceof HttpError&&e.status===401)res.setHeader('WWW-Authenticate','Bearer'); next(e); }
};
