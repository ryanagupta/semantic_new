import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { config } from './config.js';
import { HttpError } from './errors.js';

const script = `local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000); local window=tonumber(ARGV[1]); local limit=tonumber(ARGV[2]); redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-window); local count=redis.call('ZCARD',KEYS[1]); local oldest=redis.call('ZRANGE',KEYS[1],0,0,'WITHSCORES'); local reset=now+window; if #oldest>0 then reset=tonumber(oldest[2])+window end; if count>=limit then return {0,0,reset} end; redis.call('ZADD',KEYS[1],now,ARGV[3]); redis.call('PEXPIRE',KEYS[1],window); return {1,limit-count-1,reset}`;
export interface RateState {limit:number;remaining:number;reset:number;}
export class RateLimitError extends HttpError { constructor(public rate:RateState){super(429,'Rate limit exceeded.');} }
export class SlidingWindowLimiter {
  private windows = new Map<string, {times:number[];windowMs:number}>();
  private redis?: ReturnType<typeof createClient>;
  constructor(private readonly now:()=>number=Date.now){}
  get client(){return this.redis;}
  async connect() {
    if(!config.REDIS_URL) return;
    this.redis=createClient({url:config.REDIS_URL, socket:{connectTimeout:5000,reconnectStrategy:retries=>retries>5?new Error('Redis unavailable'):Math.min(1000*retries,5000)}});
    this.redis.on('error',()=>{process.stderr.write('Redis rate limit connection error\n');});
    await this.redis.connect();
  }
  async consume(id: string, limit: number, windowMs=60000) {
    if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(windowMs)||windowMs<1)throw new HttpError(503,'Invalid rate limit configuration');
    if(this.redis) {
      if(!this.redis.isReady) throw new HttpError(503,'Rate limiting service unavailable');
      const result=await this.redis.eval(script,{keys:[`nexus:rate:${id}`],arguments:[String(windowMs),String(limit),randomUUID()]}) as number[];
      if(!Array.isArray(result)||result.length!==3||![0,1].includes(Number(result[0]))||!Number.isFinite(Number(result[1]))||Number(result[1])<0||!Number.isFinite(Number(result[2])))throw new HttpError(503,'Invalid rate limiting service response');
      const rate={limit,remaining:Number(result[1]),reset:Math.ceil(Number(result[2])/1000)};
      if(Number(result[0])!==1) throw new RateLimitError(rate);
      return rate;
    }
    const now=this.now();
    if(this.windows.size>10000) for(const [key,entry] of this.windows) if(!entry.times.length || entry.times[entry.times.length-1]<=now-entry.windowMs) this.windows.delete(key);
    if(this.windows.size>=50000 && !this.windows.has(id)) throw new HttpError(503,'Rate limiter at capacity');
    const existing=this.windows.get(id);
    const effectiveWindow=Math.max(windowMs,existing?.windowMs??0);
    const times=(existing?.times??[]).filter(t=>t>now-effectiveWindow);
    const reset=Math.ceil(((times[0]??now)+effectiveWindow)/1000);
    if(times.length>=limit) throw new RateLimitError({limit,remaining:0,reset});
    times.push(now); this.windows.set(id,{times,windowMs:effectiveWindow});
    return {limit,remaining:limit-times.length,reset};
  }
  async close(){if(this.redis?.isOpen) await this.redis.quit();}
}
export const limiter=new SlidingWindowLimiter();
