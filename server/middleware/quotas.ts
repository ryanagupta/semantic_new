import { randomUUID } from 'node:crypto';
import { billingStore } from '../billing/store.js';
import { limiter } from '../limiter.js';
import { HttpError } from '../errors.js';
import { audit } from '../telemetry/logger.js';

let queue=Promise.resolve();
// All billing and quota mutations share this serial boundary. SQLite is the durable
// authority; this deployment deliberately supports one gateway writer per database.
export async function withQuotaLock<T>(operation:()=>Promise<T>|T):Promise<T>{
  const previous=queue;let release!:()=>void;queue=new Promise<void>(resolve=>{release=resolve;});
  await previous;try{return await operation();}finally{release();}
}
const debitScript=`local current=tonumber(redis.call('GET',KEYS[1]) or '0'); local cost=tonumber(ARGV[1]); if current>=cost then return redis.call('DECRBY',KEYS[1],cost) else return -1 end`;
export async function consumeQuota(cost=1){return withQuotaLock(async()=>{
  const redis=limiter.client,before=billingStore.snapshot(),key='nexus:workspace:default:credits';
  if(redis){
    if(!redis.isReady)throw new HttpError(503,'Usage metering service unavailable');
    // Reconcile from durable state under the same mutation lock; no cache flush grants credits.
    await redis.set(key,String(before.remaining));
    const remaining=Number(await redis.eval(debitScript,{keys:[key],arguments:[String(cost)]}));
    if(remaining<0)throw new HttpError(402,'Monthly usage limit reached. Please upgrade your plan or purchase add-on credits.');
  }
  return billingStore.consume(cost,randomUUID());
});}
export async function deliverQuotaNotifications(){
  const target=process.env.QUOTA_NOTIFICATION_WEBHOOK_URL;
  if(!target)return;
  const url=new URL(target);if(url.protocol!=='https:')return;
  for(const row of billingStore.notifications()){
    try {const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(process.env.QUOTA_NOTIFICATION_WEBHOOK_TOKEN?{'Authorization':`Bearer ${process.env.QUOTA_NOTIFICATION_WEBHOOK_TOKEN}`}:{})},body:String(row.payload),signal:AbortSignal.timeout(5000),redirect:'error'});billingStore.notificationAttempt(String(row.id),response.ok);}
    catch{billingStore.notificationAttempt(String(row.id),false);audit('quota.notification.failed',{id:row.id});}
  }
}
