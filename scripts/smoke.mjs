import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const base=process.env.NEXUS_SMOKE_URL||'http://127.0.0.1:3001';
const session=await fetch(`${base}/api/session`);
const cookie=session.headers.get('set-cookie')?.split(';')[0];
if(!cookie)throw new Error('Smoke test requires a local development session. Do not run it against production.');
const headers={'Content-Type':'application/json',cookie};
const client=new Client({name:'nexus-smoke',version:'1.0.0'});
let endpoint,key;
try{
  const response=await fetch(`${base}/api/endpoints`,{method:'POST',headers,body:JSON.stringify({name:`smoke_get_post_${Date.now()}`,description:'Public JSONPlaceholder smoke test',method:'GET',url:'https://jsonplaceholder.typicode.com/posts/{id}',enabled:true,inputSchema:{type:'object',properties:{id:{type:'integer',minimum:1}},required:['id'],additionalProperties:false},parameters:[{name:'id',in:'path',required:true}]})});
  assert.equal(response.status,201,await response.clone().text());endpoint=await response.json();
  const keyResponse=await fetch(`${base}/api/keys`,{method:'POST',headers,body:JSON.stringify({name:'Temporary smoke test',scopes:['tools:read','tools:call'],rateLimit:60})});
  assert.equal(keyResponse.status,201);key=await keyResponse.json();
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${key.secret}`}}}));
  const listed=await client.listTools();assert(listed.tools.some(tool=>tool.name===endpoint.name));
  const result=await client.callTool({name:endpoint.name,arguments:{id:1}});assert(!result.isError,JSON.stringify(result));
  assert.equal(JSON.parse(result.content.find(item=>item.type==='text').text).id,1);
  const metrics=await (await fetch(`${base}/api/metrics`,{headers})).json();assert(metrics.totalRequests>=1);
  process.stdout.write('PASS: real OpenAPI-style endpoint → MCP discovery → public upstream HTTP call → MCP content → durable telemetry.\n');
}finally{
  await client.close();
  if(key)await fetch(`${base}/api/keys/${key.key.id}`,{method:'DELETE',headers});
  if(endpoint)await fetch(`${base}/api/endpoints/${endpoint.id}`,{method:'DELETE',headers});
}
