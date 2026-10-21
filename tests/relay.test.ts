import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayRuntime } from '../server/relay/runtime.js';

test('Better Auth supports durable signup/login/logout while Relay records remain isolated per account',{timeout:30000},async()=>{
  process.env.NODE_ENV='test';
  const path=join(mkdtempSync(join(tmpdir(),'relay-accounts-')),'relay.db'),secret=randomBytes(48).toString('hex');
  let instance=createRelayRuntime({databasePath:path,secret,baseURL:'http://localhost:3000'});await instance.ready;
  const request=(path:string,body:unknown,cookie?:string,origin='http://localhost:3000')=>instance.auth.handler(new Request(`http://localhost:3000/api/auth/${path}`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)}));
  const cookies=(response:Response)=>response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const password='A thoughtful password 2026';
  try{
    const first=await request('sign-up/email',{name:'First Creator',email:'first@example.com',password});assert.equal(first.status,200,await first.clone().text());const one=await first.json(),cookieOne=cookies(first);assert(cookieOne.includes('relay.session_token'));
    const second=await request('sign-up/email',{name:'Second Creator',email:'second@example.com',password});assert.equal(second.status,200);const two=await second.json(),cookieTwo=cookies(second);
    assert.notEqual(one.user.id,two.user.id);
    const session=await instance.auth.api.getSession({headers:new Headers({cookie:cookieOne})});assert.equal(session?.user.id,one.user.id);
    const account=instance.database.prepare('SELECT password FROM account WHERE userId=?').get(one.user.id) as {password:string};assert.notEqual(account.password,password);assert(account.password.length>32);
    const project=instance.store.saveProject(one.user.id,{title:'A real project',description:'Saved in SQLite'});
    const note=instance.store.saveItem(one.user.id,{title:'A real note',content:'Keep this thought.',projectId:project,pinned:true});
    const task=instance.store.saveTask(one.user.id,{title:'Take the next step',projectId:project});
    assert.equal(instance.store.workspace(one.user.id).stats.projects,1);assert.equal(instance.store.workspace(one.user.id).stats.notes,1);
    assert.equal(instance.store.workspace(two.user.id).projects.length,0);assert.equal(instance.store.workspace(two.user.id).items.length,0);
    assert.throws(()=>instance.store.saveProject(two.user.id,{title:'Hijacked project'},project),/not found/);
    assert.throws(()=>instance.store.saveItem(two.user.id,{title:'Hijacked note'},note),/not found/);
    assert.throws(()=>instance.store.saveItem(two.user.id,{title:'Cross-account association',projectId:project}),/not found/);
    assert.throws(()=>instance.store.delete(two.user.id,'projects',project),/not found/);
    assert.throws(()=>instance.store.saveItem(one.user.id,{title:'Unsafe link',type:'link',url:'javascript:alert(1)'}));
    instance.store.saveTask(one.user.id,{title:'Take the next step',projectId:project,done:true},task);assert.equal(instance.store.workspace(one.user.id).stats.completedTasks,1);
    const denied=await request('sign-in/email',{email:'first@example.com',password},undefined,'https://evil.example');assert.equal(denied.status,403);
    const wrong=await request('sign-in/email',{email:'first@example.com',password:'A different password 2026'});assert.equal(wrong.status,401);
    const logout=await request('sign-out',{},cookieOne);assert.equal(logout.status,200);assert.equal(await instance.auth.api.getSession({headers:new Headers({cookie:cookieOne})}),null);
    assert.equal((await instance.auth.api.getSession({headers:new Headers({cookie:cookieTwo})}))?.user.id,two.user.id);
    instance.database.close();instance=createRelayRuntime({databasePath:path,secret,baseURL:'http://localhost:3000'});await instance.ready;
    const login=await request('sign-in/email',{email:'first@example.com',password});assert.equal(login.status,200);assert.equal((await login.json()).user.id,one.user.id);
    assert.equal(instance.store.workspace(one.user.id).items[0].content,'Keep this thought.');
    instance.store.delete(one.user.id,'projects',project);assert.equal(instance.store.workspace(one.user.id).projects.length,0);assert.equal(instance.store.workspace(one.user.id).items[0].projectId,null);assert.equal(instance.store.workspace(one.user.id).tasks[0].projectId,null);
  }finally{instance.database.close();}
});
