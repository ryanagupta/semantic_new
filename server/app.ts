import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, JSONRPCRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { config } from './config.js';
import { store } from './store.js';
import { endpointSchema,keySchema } from './validation.js';
import { checkOrigin,requireAdmin,requireKey,hasSession,setSession,clearSession,passwordMatches,authenticateToken,type AuthedRequest } from './auth.js';
import { HttpError } from './errors.js';
import { limiter,RateLimitError } from './limiter.js';
import { globalProtection,tokenProtection,rateHeaders } from './middleware/security.js';
import { createMcpServer,mountMcp,type McpDependencies } from './bridge/mcp.js';
import { gatewayMcpError } from './bridge/errors.js';
import { importOpenApi } from './bridge/openapi.js';
import { validateUpstreamUrl } from './upstream.js';
import { argumentValidator } from './bridge/validation.js';
import { executeEndpoint,requestContext,chargeExecution } from './execution.js';
import { sanitizeArguments } from './mcp/guardrails.js';
import { listRemoteTools,callRemoteTool } from './mcp/remote.js';
import { providerActor } from './mcp/proxy-guard.js';
import { billingStore } from './billing/store.js';
import { createCheckout,processDodoWebhook } from './billing/dodo.js';
import { audit } from './telemetry/logger.js';
import type { Endpoint } from '../shared/types.js';
import { listProviders } from '../config/mcp-registry.js';
import { beginOAuth,completeOAuth,getOAuthStatuses,disconnectOAuth } from './oauth/service.js';
import { allocateEnterpriseBurst,getEnterpriseBurst } from './enterprise.js';
import { mountDynamicScraperRoutes } from './gateway/dynamic-router.js';
import { scraperRouter } from './scraper/routes.js';
import { scraperStore } from './scraper/store.js';

const masked='••••••••';
function publicEndpoint(endpoint:Endpoint){return {...endpoint,headers:Object.fromEntries(Object.keys(endpoint.headers??{}).map(k=>[k,masked]))};}
async function verifySetup(endpoint:z.infer<typeof endpointSchema>){
  try{argumentValidator(endpoint);}catch(e){throw new HttpError(400,e instanceof Error?e.message:'Invalid input schema');}
  try{await validateUpstreamUrl(endpoint.url);}catch(e){throw new HttpError(400,e instanceof Error?e.message:'Upstream validation failed');}
}
const rpcSchema=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string(),z.number(),z.null()]),method:z.string().min(1).max(100),params:z.record(z.string(),z.unknown()).optional()}).strict();

export function createApp(options:{remote?:McpDependencies['remote']}={}){
  const remoteImplementation=options.remote??{listTools:listRemoteTools,callTool:callRemoteTool};
  const remote:McpDependencies['remote']={listTools:remoteImplementation.listTools,callTool:async(provider,name,args,principal)=>{
    const context=requestContext.getStore(),qualified=`${provider}__${name}`;
    if(context?.preparedRemote?.name===qualified){const result=context.preparedRemote.result;context.preparedRemote=undefined;return result;}
    return remoteImplementation.callTool(provider,name,args,principal);
  }};
  const app=express();app.disable('x-powered-by');
  const trustHops=Number(process.env.TRUST_PROXY_HOPS||0);if(trustHops>0)app.set('trust proxy',trustHops);
  app.use(helmet({contentSecurityPolicy:false}));
  app.use(globalProtection);
  app.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');requestContext.run({response:res},next);});
  app.get('/health',(_req,res)=>res.json({status:'ok',service:'nexusmcp'}));
  app.post('/api/webhooks/dodo',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
    if(!Buffer.isBuffer(req.body))throw new HttpError(415,'Expected application/json');
    const result=await processDodoWebhook(req.body,Object.fromEntries(['webhook-id','webhook-signature','webhook-timestamp'].map(name=>[name,req.get(name)])));res.json(result);
  });
  app.use(checkOrigin);
  app.use(express.json({limit:'1mb',strict:true}));
  app.get('/api/session',async(req,res)=>{
    const development=!config.production;
    if(development&&!await hasSession(req)){await setSession(res);res.json({authenticated:true,development});return;}
    res.json({authenticated:await hasSession(req),development});
  });
  app.post('/api/session',async(req,res)=>{
    await limiter.consume(`login:${req.ip}`,5,300000);
    const {password}=z.object({password:z.string().max(1024)}).strict().parse(req.body);
    if(!passwordMatches(password))throw new HttpError(401,'Incorrect workspace password');
    await setSession(res);res.json({authenticated:true});
  });
  app.delete('/api/session',(_req,res)=>{clearSession(res);res.json({authenticated:false});});
  app.get('/api/mcps/public',(_req,res)=>res.json({providers:listProviders().map(p=>({id:p.id,displayName:p.name,category:p.category,description:p.description,access:p.requiresOAuth?'gated':'free',configured:p.configured,authConfigured:p.authConfigured,connected:false,transport:p.transport}))}));
  app.post('/api/oauth/:provider/start',async(req,res)=>{
    let actor:string;
    const bearer=req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if(bearer){const principal=await authenticateToken(bearer);if(!principal.scopes.some(s=>['*','admin','tools:*','tools:call'].includes(s)||s.startsWith(`tool:${String(req.params.provider)}__`)))throw new HttpError(403,'Key does not have access to this provider');actor=providerActor(principal);}
    else if(await hasSession(req))actor='workspace-owner';
    else throw new HttpError(401,'Sign in or provide the bearer token for the identity being connected');
    await limiter.consume(`oauth:start:${actor}`,10,60000);
    const result=await beginOAuth(String(req.params.provider),actor);res.cookie(result.cookie.name,result.cookie.value,result.cookie.options);res.json({authUrl:result.authorizationUrl});
  });
  app.get('/api/oauth/:provider/callback',async(req,res)=>{
    const provider=String(req.params.provider),cookieName=`nexus_oauth_${provider}`;
    const stateCookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
    try{
      const query=z.object({code:z.string().min(1).max(4096),state:z.string().min(1).max(200)}).parse(req.query);
      await completeOAuth(provider,query,stateCookie);
      res.clearCookie(cookieName,{httpOnly:true,secure:config.production,sameSite:'lax',path:`/api/oauth/${provider}/callback`});
      res.redirect(303,`${new URL(config.APP_ORIGIN).origin}/dashboard/mcps?connected=${encodeURIComponent(provider)}`);
    }catch{
      res.clearCookie(cookieName,{httpOnly:true,secure:config.production,sameSite:'lax',path:`/api/oauth/${provider}/callback`});
      audit('oauth.callback.failed',{provider});res.redirect(303,`${new URL(config.APP_ORIGIN).origin}/dashboard/mcps?error=oauth_failed`);
    }
  });
  mountDynamicScraperRoutes(app);
  app.use('/api',requireAdmin);
  app.use('/api/scrapers',scraperRouter());
  app.get('/api/mcps',async(_req,res)=>{
    const statuses=await getOAuthStatuses('workspace-owner');
    res.json({providers:listProviders().map(p=>({id:p.id,displayName:p.name,category:p.category,description:p.description,access:p.requiresOAuth?'gated':'free',configured:p.configured,authConfigured:p.authConfigured,connected:statuses[p.id]?.connected??false,transport:p.transport}))});
  });
  app.delete('/api/oauth/:provider',async(req,res)=>{await disconnectOAuth(String(req.params.provider),'workspace-owner');res.json({disconnected:true});});
  app.get('/api/metrics',(req,res)=>{const hours=z.coerce.number().min(1).max(720).default(24).parse(req.query.hours);res.json(store.metrics(hours));});
  app.get('/api/endpoints',(_req,res)=>res.json(store.listEndpoints().map(publicEndpoint)));
  app.post('/api/endpoints',async(req,res)=>{
    if(store.listEndpoints().length>=500)throw new HttpError(409,'Endpoint limit reached (500)');
    const endpoint=endpointSchema.parse(req.body);await verifySetup(endpoint);res.status(201).json(publicEndpoint(store.saveEndpoint(endpoint)));
  });
  app.put('/api/endpoints/:id',async(req,res)=>{
    const old=store.getEndpoint(String(req.params.id));if(!old)throw new HttpError(404,'Endpoint not found');
    const generated=scraperStore.get(old.id);
    if(generated){
      const {enabled}=z.object({enabled:z.boolean()}).strict().parse(req.body);
      scraperStore.setEnabled(old.id,generated.ownerId,enabled);
      await limiter.client?.del(`relay:scrape:cache:${old.id}`);
      res.json(publicEndpoint(store.getEndpoint(old.id)!));return;
    }
    const partial=endpointSchema.partial().parse(req.body);
    const headers=partial.headers?Object.fromEntries(Object.entries(partial.headers).map(([k,v])=>[k,v===masked?old.headers?.[k]??'':v])):old.headers;
    const {id:_id,createdAt:_created,updatedAt:_updated,...base}=old;
    const endpoint=endpointSchema.parse({...base,...partial,headers});await verifySetup(endpoint);res.json(publicEndpoint(store.saveEndpoint(endpoint,old.id)));
  });
  app.delete('/api/endpoints/:id',(req,res)=>{if(!store.deleteEndpoint(String(req.params.id)))throw new HttpError(404,'Endpoint not found');res.json({deleted:true});});
  app.post('/api/endpoints/:id/test',async(req,res)=>{
    const endpoint=store.getEndpoint(String(req.params.id));if(!endpoint)throw new HttpError(404,'Endpoint not found');
    const input=z.object({arguments:z.record(z.string(),z.unknown()).default({})}).parse(req.body??{});
    const result=await executeEndpoint(endpoint,input.arguments,(req as unknown as AuthedRequest).nexusPrincipal);res.json({status:result.status,contentType:result.contentType,body:result.body});
  });
  app.post('/api/import',async(req,res)=>{
    const {spec}=z.object({spec:z.union([z.string().max(1048576),z.record(z.string(),z.unknown())])}).parse(req.body);
    let parsed:unknown;try{parsed=typeof spec==='string'?parseYaml(spec,{maxAliasCount:0}):spec;}catch{throw new HttpError(400,'Invalid JSON or YAML specification');}
    let endpoints;try{endpoints=importOpenApi(parsed).map(e=>endpointSchema.parse(e));}catch(e){throw new HttpError(400,e instanceof Error?e.message:'Invalid OpenAPI specification');}
    if(!endpoints.length||endpoints.length+store.listEndpoints().length>500)throw new HttpError(400,'Import must contain 1–500 endpoints within the workspace limit');
    for(const endpoint of endpoints)await verifySetup(endpoint);
    const imported=store.importEndpoints(endpoints);res.status(201).json({imported:imported.length,endpoints:imported.map(publicEndpoint)});
  });
  app.get('/api/keys',(_req,res)=>res.json(store.listKeys()));
  app.post('/api/keys',(req,res)=>{const input=keySchema.parse(req.body);if(input.rateLimit>billingStore.snapshot().maxRateLimit)throw new HttpError(403,'Rate limit exceeds this workspace plan');if(store.listKeys().filter(k=>!k.revokedAt).length>=100)throw new HttpError(409,'Active key limit reached (100)');res.status(201).json(store.createKey(input.name,input.scopes,input.rateLimit));});
  app.delete('/api/keys/:id',(req,res)=>{if(!store.revokeKey(String(req.params.id)))throw new HttpError(404,'Active API key not found');res.json({revoked:true});});
  app.get('/api/billing',(_req,res)=>res.json(billingStore.snapshot()));
  app.get('/api/enterprise/burst',async(_req,res)=>res.json(await getEnterpriseBurst()));
  app.put('/api/enterprise/burst',async(req,res)=>res.json(await allocateEnterpriseBurst(req.body)));
  app.post('/api/billing/checkout',async(req,res)=>{await limiter.consume('checkout:workspace',5,60000);res.json(await createCheckout(req.body));});
  app.post('/api/inspector',async(req,res)=>{
    const parsed=rpcSchema.safeParse(req.body);
    if(!parsed.success){res.status(400).json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid JSON-RPC request'}});return;}
    const payload=parsed.data;
    const client=new Client({name:'nexus-dashboard-inspector',version:'1.0.0'});
    const server=createMcpServer({listEndpoints:()=>store.listEndpoints(),execute:executeEndpoint,principal:(req as AuthedRequest).nexusPrincipal,remote});
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    try{
      await server.connect(serverTransport);await client.connect(clientTransport);
      const result=await client.request({method:payload.method,params:payload.params},z.object({}).passthrough(),{timeout:20000});
      res.json({jsonrpc:'2.0',id:payload.id,result});
    }catch(e){res.json({jsonrpc:'2.0',id:payload.id,error:{code:typeof (e as {code?:unknown})?.code==='number'?(e as {code:number}).code:-32603,message:e instanceof Error?e.message:'Protocol request failed'}});}
    finally{await client.close();await server.close();}
  });
  app.all('/gateway/:id',requireKey,tokenProtection,async(req,res)=>{
    const endpoint=store.getEndpoint(String(req.params.id));if(!endpoint)throw new HttpError(404,'Endpoint not found');
    if(req.method!==endpoint.method){res.setHeader('Allow',endpoint.method);throw new HttpError(405,'HTTP method does not match this endpoint');}
    const args:Record<string,unknown>={};
    for(const mapping of endpoint.parameters){const property=mapping.inputProperty??mapping.name;const value=req.query[property];if(value!==undefined){const properties=endpoint.inputSchema.properties as Record<string,{type?:string}>|undefined;const type=properties?.[property]?.type;args[property]=type==='integer'||type==='number'?Number(value):type==='boolean'?value==='true'?true:value==='false'?false:value:value;}}
    if(endpoint.bodyProperty&&req.body!==undefined)args[endpoint.bodyProperty]=req.body;
    if(endpoint.kind==='graphql'&&!endpoint.bodyProperty&&req.body&&typeof req.body==='object')Object.assign(args,req.body);
    const result=await executeEndpoint(endpoint,args,(req as unknown as AuthedRequest).nexusPrincipal);
    res.status(result.status).setHeader('Content-Type',result.contentType||'application/octet-stream');res.end(result.bytes??result.body);
  });
  const preflight:RequestHandler=async(req,_res,next)=>{
    try{
      if(req.body?.method==='tools/call'){
        if(!JSONRPCRequestSchema.safeParse(req.body).success)throw new HttpError(400,'Invalid JSON-RPC tool request');
        const parsed=CallToolRequestSchema.safeParse(req.body);
        if(!parsed.success)throw new HttpError(400,'Invalid tools/call request');
        const name=parsed.data.params.name;
        const endpoint=store.listEndpoints().find(e=>e.name===name);
        if(endpoint){try{sanitizeArguments(endpoint,parsed.data.params.arguments??{});}catch(e){throw new HttpError(400,e instanceof Error?e.message:'Invalid tool arguments');}await chargeExecution(endpoint,(req as AuthedRequest).nexusPrincipal);const context=requestContext.getStore();if(context)context.charged=endpoint.id;}
        else if(name.includes('__')){const principal=(req as AuthedRequest).nexusPrincipal;if(!principal.scopes.some(scope=>['*','admin','tools:*','tools:call',`tool:${name}`].includes(scope)))throw new HttpError(403,'API key does not have permission for this remote tool');const context=requestContext.getStore();if(!context)throw new HttpError(500,'Request execution context unavailable');const separator=name.indexOf('__');const result=await remoteImplementation.callTool(name.slice(0,separator),name.slice(separator+2),parsed.data.params.arguments??{},principal);context.preparedRemote={name,result};}
      }else if(req.body?.method==='resources/read'){
        if(!JSONRPCRequestSchema.safeParse(req.body).success)throw new HttpError(400,'Invalid JSON-RPC resource request');
        const parsed=ReadResourceRequestSchema.safeParse(req.body);if(!parsed.success)throw new HttpError(400,'Invalid resources/read request');
        const endpoint=store.listEndpoints().find(e=>`nexus://endpoints/${e.id}`===parsed.data.params.uri&&e.method==='GET'&&!e.parameters.some(p=>p.required||p.in==='path')&&!(Array.isArray(e.inputSchema.required)&&e.inputSchema.required.length));
        if(endpoint){try{sanitizeArguments(endpoint,{});}catch(e){throw new HttpError(400,e instanceof Error?e.message:'Resource requires input arguments');}await chargeExecution(endpoint,(req as AuthedRequest).nexusPrincipal,'resource');}
      }next();
    }catch(e){next(e);}
  };
  const authenticate:RequestHandler=(req,res,next)=>requireKey(req,res,error=>{if(error)return next(error);tokenProtection(req,res,next);});
  mountMcp(app,{listEndpoints:()=>store.listEndpoints(),execute:executeEndpoint,authenticate,preflight,remote});
  app.use((_req,res)=>res.status(404).json({error:'Route not found'}));
  const errorHandler:ErrorRequestHandler=(error,req,res,_next)=>{
    if(res.headersSent){res.end();return;}
    if(error instanceof RateLimitError)rateHeaders(res,error.rate);
    if(typeof error?.retryAfter==='number')res.setHeader('Retry-After',Math.max(1,Math.ceil(error.retryAfter)));
    if(error?.code===-32001){res.status(401).json({jsonrpc:'2.0',id:req.body?.id??null,error:{code:-32001,message:error.message,data:error.data}});return;}
    const status=error instanceof z.ZodError?400:typeof error?.status==='number'?error.status:typeof error?.statusCode==='number'?error.statusCode:/UNIQUE constraint failed: endpoints.name/.test(error?.message??'')?409:500;
    let message=error instanceof z.ZodError?error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '):status===413?'Payload Too Large':error?.name==='CircuitOpenError'?'Upstream service degraded':status===409&&!(error instanceof HttpError)?'An endpoint with this tool name already exists':status>=500&&!(error instanceof HttpError)?'Gateway request failed':error instanceof Error?error.message:'Request failed';
    if(status===400&&error?.type==='entity.parse.failed')message='Invalid JSON body';
    audit('request.error',{method:req.method,path:req.originalUrl,status,error:message});
    if(req.path==='/mcp'||req.path==='/messages'){const protocolError=gatewayMcpError(error);res.status(status).json({jsonrpc:'2.0',id:typeof req.body?.id==='string'||typeof req.body?.id==='number'?req.body.id:null,error:{code:protocolError.code,message,data:protocolError.data}});return;}
    res.status(status).json({error:message});
  };
  app.use(errorHandler);return app;
}
