import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

process.env.DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'nexus-transports-')),'test.db');
process.env.NODE_ENV='test';
delete process.env.REDIS_URL;
delete process.env.JWT_ISSUER;delete process.env.JWT_AUDIENCE;delete process.env.JWT_JWKS_URL;
const {createApp}=await import('../server/app.js');
const {store}=await import('../server/store.js');
const {billingStore}=await import('../server/billing/store.js');
const {authenticateToken}=await import('../server/auth.js');
const {executeEndpoint}=await import('../server/execution.js');
const {mountWebSocket}=await import('../server/bridge/websocket.js');
const {shutdownMcp}=await import('../server/bridge/mcp.js');
const http=createServer(createApp());
const wsServer=mountWebSocket(http,{listEndpoints:()=>store.listEndpoints(),execute:executeEndpoint,authenticateToken});
let base:string;
const childEnvironment=(key:string):Record<string,string>=>({...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)),NEXUS_API_KEY:key,NODE_ENV:'test',DATABASE_PATH:process.env.DATABASE_PATH!,REDIS_URL:''});
function deadline<T>(promise:Promise<T>,milliseconds=8000):Promise<T>{return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(`Operation exceeded ${milliseconds}ms`)),milliseconds);promise.then(value=>{clearTimeout(timeout);resolve(value);},error=>{clearTimeout(timeout);reject(error);});});}
before(async()=>{store.saveEndpoint({name:'transport_schema',description:'A schema available on every transport',method:'GET',url:'https://example.invalid/read',enabled:true,inputSchema:{type:'object',properties:{}},parameters:[]});await new Promise<void>(done=>http.listen(0,'127.0.0.1',done));const address=http.address();assert(address&&typeof address!=='string');base=`http://127.0.0.1:${address.port}`;});
after(async()=>{await shutdownMcp();for(const socket of wsServer.clients)socket.terminate();wsServer.close();http.closeAllConnections();await new Promise<void>(done=>http.close(()=>done()));store.close();billingStore.close();});

class AuthenticatedWebSocketClient implements Transport{
  onclose?:()=>void;onerror?:(error:Error)=>void;onmessage?:Transport['onmessage'];
  socket?:WebSocket;
  constructor(private readonly url:string,private readonly key:string){}
  async start(){this.socket=new WebSocket(this.url,{headers:{Authorization:`Bearer ${this.key}`}});this.socket.on('message',data=>{try{this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(data.toString())));}catch(error){this.onerror?.(error instanceof Error?error:new Error('Invalid JSON-RPC'));}});this.socket.on('close',()=>this.onclose?.());this.socket.on('error',error=>this.onerror?.(error));await once(this.socket,'open');}
  async send(message:JSONRPCMessage){const socket=this.socket;if(!socket||socket.readyState!==WebSocket.OPEN)throw new Error('WebSocket is closed');await new Promise<void>((done,reject)=>socket.send(JSON.stringify(message),error=>error?reject(error):done()));}
  async close(){const socket=this.socket;if(!socket||socket.readyState===WebSocket.CLOSED)return;const closed=once(socket,'close');socket.close();await deadline(closed);}
}
async function rawSocket(key:string){const socket=new WebSocket(base.replace('http:','ws:')+'/ws',{headers:{Authorization:`Bearer ${key}`}});socket.on('error',()=>{});await deadline(once(socket,'open'));return socket;}

test('The official SSE client negotiates tools, resources and prompts and observes revocation on its next POST',{timeout:20000},async()=>{
  const {key,secret}=store.createKey('SSE transport',['tools:read','resources:read','prompts:read'],60);
  const client=new Client({name:'sse-integration',version:'1'});
  try{
    await deadline(client.connect(new SSEClientTransport(new URL(base+'/sse'),{requestInit:{headers:{Authorization:`Bearer ${secret}`}}})));
    assert((await client.listTools()).tools.some(tool=>tool.name==='transport_schema'));
    assert((await client.listResources()).resources.some(resource=>resource.name==='transport_schema'));
    assert((await client.listPrompts()).prompts.some(prompt=>prompt.name==='invoke_tool'));
    store.revokeKey(key.id);
    await assert.rejects(()=>deadline(client.listTools()));
  }finally{await client.close();}
});

test('The official SDK over authenticated WebSocket shares the HTTP key budget and closes revoked sessions',{timeout:20000},async()=>{
  const limited=store.createKey('Shared transport budget',['tools:read'],4);
  const transport=new AuthenticatedWebSocketClient(base.replace('http:','ws:')+'/ws',limited.secret);
  const client=new Client({name:'ws-rate-integration',version:'1'});
  try{
    await deadline(client.connect(transport));
    assert((await client.listTools()).tools.some(tool=>tool.name==='transport_schema'));
    const fourth=await fetch(base+'/mcp',{headers:{Authorization:`Bearer ${limited.secret}`}});
    assert.equal(fourth.headers.get('X-RateLimit-Limit'),'4');assert.equal(fourth.headers.get('X-RateLimit-Remaining'),'0');
    const closed=once(transport.socket!,'close');
    await assert.rejects(()=>deadline(client.listTools()));
    assert.equal((await deadline(closed))[0],1008);
  }finally{await client.close();}
  const fresh=store.createKey('Revoked WS transport',['tools:read'],60);
  const revokedTransport=new AuthenticatedWebSocketClient(base.replace('http:','ws:')+'/ws',fresh.secret);
  const revokedClient=new Client({name:'ws-revocation-integration',version:'1'});
  try{await deadline(revokedClient.connect(revokedTransport));store.revokeKey(fresh.key.id);const closed=once(revokedTransport.socket!,'close');await assert.rejects(()=>deadline(revokedClient.listTools()));assert.equal((await deadline(closed))[0],1008);}finally{await revokedClient.close();}
});

test('WebSocket rejects binary frames and closes oversized payloads before JSON-RPC processing',{timeout:20000},async()=>{
  const {secret}=store.createKey('Frame policy',['tools:read'],60);
  const binary=await rawSocket(secret);
  let closed=once(binary,'close');binary.send(Buffer.from('{}'));assert.equal((await deadline(closed))[0],1003);
  const oversized=await rawSocket(secret);
  closed=once(oversized,'close');oversized.send('x'.repeat(1_048_577));assert.equal((await deadline(closed))[0],1009);
});

test('A real stdio subprocess negotiates with the official SDK, emits no protocol noise, and rechecks revocation',{timeout:25000},async()=>{
  const {key,secret}=store.createKey('Stdio SDK integration',['tools:read','resources:read','prompts:read'],60);
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','server/stdio.ts'],cwd:resolve('.'),env:childEnvironment(secret),stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',chunk=>{stderr+=String(chunk);});
  const client=new Client({name:'stdio-integration',version:'1'});const protocolErrors:Error[]=[];client.onerror=error=>protocolErrors.push(error);
  try{
    await deadline(client.connect(transport),15000);
    assert((await client.listTools()).tools.some(tool=>tool.name==='transport_schema'));
    assert((await client.listResources()).resources.length>0);assert((await client.listPrompts()).prompts.length>0);
    assert.equal(protocolErrors.length,0,'stdout must contain only valid MCP messages');
    assert(!stderr.includes(secret),'stderr must not disclose bearer credentials');
    store.revokeKey(key.id);await assert.rejects(()=>deadline(client.listTools()),/authentication or rate limit/);
  }finally{await client.close();}
});

test('Stdio applies key limits to discovery messages as well as tool execution',{timeout:25000},async()=>{
  const {secret}=store.createKey('Stdio bounded discovery',['tools:read','resources:read','prompts:read'],4);
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','server/stdio.ts'],cwd:resolve('.'),env:childEnvironment(secret),stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  const client=new Client({name:'stdio-rate-integration',version:'1'});
  try{await deadline(client.connect(transport),15000);await client.listTools();await client.listResources();await assert.rejects(()=>deadline(client.listPrompts()),/authentication or rate limit/);}finally{await client.close();}
});

test('Closing stdio input exits the server cleanly without requiring a termination signal',{timeout:25000},async()=>{
  const {secret}=store.createKey('Stdio EOF integration',['tools:read'],60);
  const child=spawn(process.execPath,['--import','tsx','server/stdio.ts'],{cwd:resolve('.'),env:childEnvironment(secret),stdio:['pipe','pipe','pipe'],windowsHide:true});
  let output='',lineBuffer='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>stderr+=chunk);
  const initialized=new Promise<void>((done,reject)=>{child.stdout.on('data',chunk=>{output+=chunk;lineBuffer+=chunk;const lines=lineBuffer.split('\n');lineBuffer=lines.pop()!;for(const line of lines.filter(Boolean)){try{const message=JSONRPCMessageSchema.parse(JSON.parse(line));if('id' in message&&message.id===1&&'result' in message)done();}catch(error){reject(error);}}});child.once('error',reject);child.once('exit',code=>{if(!output.includes('"result"'))reject(new Error(`Stdio exited ${code}: ${stderr}`));});});
  const exited=once(child,'exit');
  try{
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'eof-integration',version:'1'}}})+'\n');
    await deadline(initialized,15000);child.stdin.end();const [code,signal]=await deadline(exited,5000);assert.equal(code,0);assert.equal(signal,null);
    for(const line of output.trim().split('\n'))assert(JSONRPCMessageSchema.safeParse(JSON.parse(line)).success);
  }finally{if(child.exitCode===null)child.kill();}
});
