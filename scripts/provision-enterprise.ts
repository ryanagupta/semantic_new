import 'dotenv/config';
import { store } from '../server/store.js';
import { billingStore,plans } from '../server/billing/store.js';
import { z } from 'zod';
const months=z.coerce.number().int().min(1).max(12).parse(process.argv[2]??1);
const start=new Date(),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+months);
billingStore.transaction(()=>{
  billingStore.db.prepare("UPDATE billing_workspace SET tier='enterprise',monthly_limit=?,credits=MAX(0,credits-MAX(0,used-monthly_limit)),used=0,period_start=?,period_end=?,subscription_id=NULL,subscription_order_id=NULL,terminal=0,version=version+1 WHERE id='default'").run(plans.enterprise.monthly,start.toISOString(),end.toISOString());
});
process.stdout.write(`Enterprise policy provisioned until ${end.toISOString()}.\n`);
billingStore.close();store.close();
