import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import DodoPayments from 'dodopayments';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { limiter } from '../limiter.js';
import { billingStore, type BillingEvent } from './store.js';
import { withQuotaLock } from '../middleware/quotas.js';
import { audit } from '../telemetry/logger.js';

export const checkoutSchema=z.object({
  plan:z.enum(['pro','credits']),quantity:z.number().int().min(1).max(100),
  email:z.email().max(254),name:z.string().trim().min(1).max(100),
  billingAddress:z.object({country:z.string().regex(/^[A-Z]{2}$/),zipcode:z.string().min(1).max(20),street:z.string().min(1).max(200),city:z.string().min(1).max(100),state:z.string().min(1).max(100)}).strict(),
}).strict().refine(v=>v.plan!=='pro'||v.quantity===1,'Subscription quantity must be 1');
export function verifyDodoWebhook(raw:Buffer,headers:Record<string,string|undefined>,key=process.env.DODO_PAYMENTS_WEBHOOK_KEY,now=Date.now()):BillingEvent{
  if(!key)throw new HttpError(503,'Dodo webhook signing key is not configured');
  const id=headers['webhook-id'],timestamp=headers['webhook-timestamp'],signature=headers['webhook-signature'];
  if(!id||id.length>200||!timestamp||!/^\d{10,12}$/.test(timestamp)||!signature||signature.length>2048)throw new HttpError(401,'Invalid webhook headers');
  if(Math.abs(now/1000-Number(timestamp))>300)throw new HttpError(401,'Webhook timestamp outside the allowed window');
  const encoded=key.startsWith('whsec_')?key.slice(6):key;
  const secret=Buffer.from(encoded,'base64');
  if(secret.length<16)throw new HttpError(503,'Invalid webhook signing key configuration');
  const expected=createHmac('sha256',secret).update(`${id}.${timestamp}.`).update(raw).digest();
  const valid=signature.split(/\s+/).some(part=>{const [version,value]=part.split(',');if(version!=='v1'||!value||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))return false;const candidate=Buffer.from(value,'base64');return candidate.length===expected.length&&timingSafeEqual(candidate,expected);});
  if(!valid)throw new HttpError(401,'Invalid webhook signature');
  let payload:unknown;try{payload=JSON.parse(raw.toString('utf8'));}catch{throw new HttpError(400,'Invalid webhook JSON');}
  const parsed=z.object({business_id:z.string().optional(),type:z.string().max(100),timestamp:z.iso.datetime({offset:true}),data:z.record(z.string(),z.unknown())}).parse(payload);
  if(process.env.DODO_BUSINESS_ID && parsed.business_id!==process.env.DODO_BUSINESS_ID)throw new HttpError(401,'Webhook business does not match');
  return parsed;
}
export async function processDodoWebhook(raw:Buffer,headers:Record<string,string|undefined>){
  const event=verifyDodoWebhook(raw,headers),id=headers['webhook-id']!;
  const redis=limiter.client;
  if(!redis?.isReady)throw new HttpError(503,'Redis is required for payment fulfillment');
  if(billingStore.processed(id))return {received:true,duplicate:true};
  const key=`dodo_evt:${id}`,claim=`processing:${randomUUID()}`;
  const claimed=await redis.set(key,claim,{NX:true,EX:30});
  if(!claimed){
    if(billingStore.processed(id))return {received:true,duplicate:true};
    // Never acknowledge work another worker has claimed but has not durably fulfilled.
    throw new HttpError(503,'Webhook processing in progress; retry delivery');
  }
  try{
    const result=await withQuotaLock(()=>billingStore.fulfill(id,event));
    await redis.set(key,'done',{EX:259200});
    audit('billing.webhook',{id,type:event.type,result});return {received:true,result};
  }catch(e){
    await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",{keys:[key],arguments:[claim]}).catch(()=>{});
    throw e;
  }
}
export async function createCheckout(input:unknown){
  const request=checkoutSchema.parse(input);
  if(!billingStore.snapshot().configured)throw new HttpError(503,'Billing is not configured. Set Dodo credentials, catalog products, and Redis.');
  if(request.plan==='pro' && billingStore.snapshot().tier!=='free')throw new HttpError(409,'This workspace already has an active paid subscription');
  const productId=request.plan==='pro'?process.env.DODO_PRO_PRODUCT_ID!:process.env.DODO_CREDITS_PRODUCT_ID!;
  const environment=process.env.DODO_PAYMENTS_ENVIRONMENT==='live_mode'?'live_mode':'test_mode';
  const dodo=new DodoPayments({bearerToken:process.env.DODO_PAYMENTS_API_KEY!,environment,timeout:15000,maxRetries:0,baseURL:environment==='live_mode'?'https://live.dodopayments.com':'https://test.dodopayments.com'});
  const pending=request.plan==='pro'?billingStore.getPendingOrder():undefined;
  if(pending && pending.email.toLowerCase()!==request.email.toLowerCase())throw new HttpError(409,'A subscription checkout is already pending for a different customer. Resume it using the original email.');
  if(pending && (pending.productId!==productId||pending.quantity!==request.quantity))throw new HttpError(409,'The pending subscription checkout does not match this catalog configuration');
  if(pending?.checkoutUrl)return {checkoutUrl:pending.checkoutUrl};
  const orderId=pending?.id??billingStore.createOrder(request.plan,productId,request.quantity,request.email);
  try{
    const session=await dodo.checkoutSessions.create({
      product_cart:[{product_id:productId,quantity:request.quantity}],confirm:true,
      customer:{email:request.email,name:request.name},
      billing_address:request.billingAddress as DodoPayments.CheckoutSessionBillingAddress,
      return_url:`${new URL(config.APP_ORIGIN).origin}/dashboard/billing?checkout=returned`,
      cancel_url:`${new URL(config.APP_ORIGIN).origin}/dashboard/billing?checkout=cancelled`,
      metadata:{nexus_order_id:orderId,nexus_workspace_id:'default'},
      feature_flags:{allow_discount_code:false,allow_currency_selection:false,allow_customer_editing_email:false,allow_customer_editing_name:false,allow_editing_addons:false},
      customization:{theme:'dark'},
    },{idempotencyKey:orderId});
    if(!session.checkout_url)throw new HttpError(502,'Dodo did not return a hosted checkout URL');
    const url=new URL(session.checkout_url);
    if(url.protocol!=='https:'||!(url.hostname==='dodopayments.com'||url.hostname.endsWith('.dodopayments.com')))throw new HttpError(502,'Invalid checkout URL from payment provider');
    billingStore.bindSession(orderId,session.session_id,url.toString());
    return {checkoutUrl:url.toString()};
  }catch(e){
    // Keep ambiguous network/server failures pending: retry the same provider idempotency key.
    if(typeof (e as {status?:unknown})?.status==='number' && Number((e as {status:number}).status)>=400 && Number((e as {status:number}).status)<500)billingStore.failOrder(orderId);
    audit('billing.checkout.failed',{orderId});if(e instanceof HttpError)throw e;throw new HttpError(502,'Unable to create Dodo checkout. Verify the product catalog and billing details.');
  }
}
