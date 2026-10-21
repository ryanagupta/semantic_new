import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'nexus-preflight-')),'test.db');
process.env.NODE_ENV='test';
const {createApp}=await import('../server/app.js');
const {store}=await import('../server/store.js');
const {billingStore}=await import('../server/billing/store.js');
const {consumeQuota}=await import('../server/middleware/quotas.js');
const {HttpError}=await import('../server/errors.js');
const {RateLimitError}=await import('../server/limiter.js');
const {CircuitOpenError}=await import('../server/gateway/circuit-breaker.js');
const {createMcpServer,shutdownMcp}=await import('../server/bridge/mcp.js');

test('HTTP preflight rejects invalid transport/resource inputs without debits and executes remote calls exactly once',{timeout:20000},async()=>{
  let remoteCalls=0;
  const app=createApp({remote:{
    listTools:async()=>[{name:'fixture__success',inputSchema:{type:'object'}}],
    callTool:async(_provider,name)=>{
      remoteCalls++;
      if(name==='quota')throw new HttpError(402,'Monthly usage limit reached');
      if(name==='rate')throw new RateLimitError({limit:10,remaining:0,reset:Math.floor(Date.now()/1000)+15});
      if(name==='circuit')throw new CircuitOpenError('fixture',15);
      await consumeQuota();
      return {content:[{type:'text',text:'remote result'}]};
    },
  }});
  const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const {secret}=store.createKey('Preflight fixture',['tools:read','tools:call','resources:read'],60);
  const client=new Client({name:'preflight-test',version:'1'});
  const transport=new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${secret}`}}});
  try{
    await client.connect(transport);
    const validHeaders={'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${secret}`,'Mcp-Session-Id':transport.sessionId!};
    const body=(name:string,id=10)=>JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:{}}});
    const before=billingStore.snapshot().used;
    const headersToReject=[{headers:{...validHeaders,Accept:'application/json'},status:406},{headers:{...validHeaders,'Content-Type':'text/plain'},status:415},{headers:{...validHeaders,'Mcp-Protocol-Version':'unsupported-version'},status:400}];
    for(const fixture of headersToReject){
      const rejected=await fetch(`${base}/mcp`,{method:'POST',headers:fixture.headers,body:body('fixture__success')});
      assert.equal(rejected.status,fixture.status);await rejected.body?.cancel();
    }
    assert.equal(remoteCalls,0,'Transport rejection must precede remote execution');
    assert.equal(billingStore.snapshot().used,before);
    for(const [name,status]of [['quota',402],['rate',429],['circuit',503]]as const){
      const response=await fetch(`${base}/mcp`,{method:'POST',headers:validHeaders,body:body(`fixture__${name}`)});
      assert.equal(response.status,status);
      const envelope=await response.json();assert.equal(envelope.jsonrpc,'2.0');assert.equal(envelope.id,10);assert.equal(envelope.error.data.httpStatus,status);
      if(name==='rate'){assert.equal(response.headers.get('x-ratelimit-remaining'),'0');assert(Number(response.headers.get('x-ratelimit-reset'))>=Math.floor(Date.now()/1000));assert(Number(response.headers.get('retry-after'))>0);}
      if(name==='circuit')assert.equal(response.headers.get('retry-after'),'15');
    }
    assert.equal(billingStore.snapshot().used,before,'Rejected policy checks must not consume credits');
    const callsBeforeSuccess=remoteCalls;
    const successful=await client.callTool({name:'fixture__success',arguments:{}});
    assert.deepEqual(successful.content,[{type:'text',text:'remote result'}]);
    assert.equal(remoteCalls,callsBeforeSuccess+1,'The SDK must consume the prepared result instead of invoking twice');
    assert.equal(billingStore.snapshot().used,before+1,'Exactly one completed remote call is metered');
    const endpoint=store.saveEndpoint({name:'composed_resource',description:'Requires hidden input through allOf',method:'GET',url:'https://example.com/data',enabled:true,inputSchema:{type:'object',properties:{hidden:{type:'string'}},allOf:[{required:['hidden']}],additionalProperties:false},parameters:[],headers:{}});
    const resource=await fetch(`${base}/mcp`,{method:'POST',headers:validHeaders,body:JSON.stringify({jsonrpc:'2.0',id:12,method:'resources/read',params:{uri:`nexus://endpoints/${endpoint.id}`}})});
    assert.equal(resource.status,400);await resource.body?.cancel();
    assert.equal(billingStore.snapshot().used,before+1,'Invalid composed resource schemas must not consume quota');
  }finally{await client.close();await shutdownMcp();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();billingStore.close();}
});

test('Non-HTTP MCP errors preserve quota and retry details for remote tools and resources',async()=>{
  const principal={id:'dashboard',scopes:['admin'],rateLimit:60};
  const endpoint={id:'readable',name:'readable',description:'fixture',method:'GET' as const,url:'https://example.com',enabled:true,inputSchema:{type:'object',properties:{}},parameters:[],createdAt:'',updatedAt:''};
  const server=createMcpServer({principal,listEndpoints:()=>[endpoint],execute:async()=>{throw new HttpError(402,'Quota exhausted');},remote:{listTools:async()=>[],callTool:async()=>{throw new RateLimitError({limit:10,remaining:0,reset:Math.floor(Date.now()/1000)+10});}}});
  const client=new Client({name:'structured-policy-test',version:'1'});
  const[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await server.connect(serverTransport);
  try{
    await client.connect(clientTransport);
    await assert.rejects(client.callTool({name:'fixture__remote'}),error=>{const data=(error as {data:{httpStatus:number;retryAfter:number}}).data;assert.equal(data.httpStatus,429);assert(data.retryAfter>0);return true;});
    await assert.rejects(client.readResource({uri:'nexus://endpoints/readable'}),error=>{assert.equal((error as {data:{httpStatus:number}}).data.httpStatus,402);return true;});
  }finally{await client.close();await server.close();}
});
