import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'nexus-gateway-')),'test.db');
process.env.NODE_ENV='test';
const {createApp}=await import('../server/app.js');
const {store}=await import('../server/store.js');
const {billingStore}=await import('../server/billing/store.js');
const {shutdownMcp}=await import('../server/bridge/mcp.js');

test('gateway protects admin APIs, keeps secrets one-time, negotiates real MCP, and enforces body/origin boundaries',async()=>{
  const server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const client=new Client({name:'gateway-test',version:'1'});
  try{
    assert.equal((await fetch(`${base}/api/keys`)).status,401);
    const session=await fetch(`${base}/api/session`);assert.equal(session.status,200);
    const cookie=session.headers.get('set-cookie')!.split(';')[0];assert(cookie.startsWith('nexus_session='));
    const headers={'Content-Type':'application/json',cookie};
    const create=await fetch(`${base}/api/keys`,{method:'POST',headers,body:JSON.stringify({name:'Integration test',scopes:['tools:read','tools:call'],rateLimit:60})});assert.equal(create.status,201);
    const {secret,key}=await create.json();assert(secret.startsWith('nx_live_'));
    const list=await (await fetch(`${base}/api/keys`,{headers})).text();assert(!list.includes(secret));assert(!list.includes('secret_hash'));
    assert.equal((await fetch(`${base}/api/keys`,{method:'POST',headers,body:JSON.stringify({name:'Excess',scopes:['tools:call'],rateLimit:1000})})).status,403);
    assert.equal((await fetch(`${base}/api/keys`,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
    assert.equal((await fetch(`${base}/api/endpoints`,{method:'POST',headers,body:JSON.stringify({name:'private',method:'GET',url:'http://127.0.0.1/private'})})).status,400);
    const endpoint=store.saveEndpoint({name:'safe_tool',description:'Test tool',method:'GET',url:'https://example.com/{id}',enabled:true,inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},parameters:[{name:'id',in:'path',required:true}],headers:{Authorization:'Bearer upstream-test-secret'}});
    const endpointList=await (await fetch(`${base}/api/endpoints`,{headers})).text();assert(!endpointList.includes('upstream-test-secret'));assert(endpointList.includes('••••••••'));
    const transport=new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${secret}`}}});
    await client.connect(transport);const tools=await client.listTools();assert(tools.tools.some(t=>t.name==='safe_tool'));
    const before=billingStore.snapshot().used;
    await assert.rejects(()=>client.callTool({name:'safe_tool',arguments:{id:'../private'}}));
    assert.equal(billingStore.snapshot().used,before,'invalid arguments must not consume quota');
    const invalid=await fetch(`${base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${secret}`,'Mcp-Session-Id':'invalid'},body:JSON.stringify({jsonrpc:'2.0',id:90,method:'tools/call',params:{name:'safe_tool',arguments:{id:'valid'}}})});assert.equal(invalid.status,404);assert.equal(billingStore.snapshot().used,before,'invalid session must not consume quota');
    const inspector=await fetch(`${base}/api/inspector`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(inspector.status,200);assert((await inspector.json()).result.tools.length>=1);
    const oversized=await fetch(`${base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({data:'x'.repeat(1048576)})});assert.equal(oversized.status,413);
    const fakeWebhook=await fetch(`${base}/api/webhooks/dodo`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert([401,503].includes(fakeWebhook.status));
    await fetch(`${base}/api/keys/${key.id}`,{method:'DELETE',headers});
    const denied=await fetch(`${base}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,401);
    store.deleteEndpoint(endpoint.id);
  }finally{await client.close();await shutdownMcp();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();billingStore.close();}
});
