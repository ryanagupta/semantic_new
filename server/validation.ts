import { z } from 'zod';
export const endpointSchema=z.object({
  name:z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  description:z.string().max(2000).default(''),
  method:z.enum(['GET','POST','PUT','PATCH','DELETE','HEAD']),
  url:z.string().min(1).max(4096).refine(value=>{try{const u=new URL(value.replace(/\{[^}]+\}/g,'value'));return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.hash;}catch{return false;}},'Enter an HTTP(S) URL without credentials or a fragment'),
  enabled:z.boolean().default(true),
  inputSchema:z.record(z.string(),z.unknown()).default({type:'object',properties:{},additionalProperties:false}),
  parameters:z.array(z.object({name:z.string().min(1).max(256),in:z.enum(['path','query','header']),required:z.boolean().optional(),style:z.enum(['simple','form','spaceDelimited','pipeDelimited','deepObject']).optional(),explode:z.boolean().optional(),inputProperty:z.string().optional()})).max(100).default([]),
  bodyProperty:z.string().optional(),
  headers:z.record(z.string(),z.string().max(8192)).default({}),
  kind:z.enum(['rest','graphql']).default('rest'),
}).strict();
export const keySchema=z.object({name:z.string().trim().min(1).max(80),scopes:z.array(z.string().regex(/^(\*|tools:\*|tools:read|tools:call|resources:read|prompts:read|tool:[a-zA-Z0-9_-]+)$/)).min(1).max(100),rateLimit:z.number().int().min(1).max(100000)}).strict();
