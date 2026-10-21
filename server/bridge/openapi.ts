import type { EndpointInput, HttpMethod, JsonSchema, ParameterMapping } from '../../shared/types.js';

type ObjectValue = Record<string, unknown>;
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head']);
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertObject(value: unknown, label: string): ObjectValue {
  if (!object(value)) throw new Error(`${label} must be an object.`);
  return value;
}

/** Resolve only local JSON pointers. No files, URLs, or network references are read. */
function resolveDocument(input: unknown): ObjectValue {
  const root = assertObject(input, 'OpenAPI document');
  let nodes = 0;
  function visit(value: unknown, refs: Set<string>, depth: number): unknown {
    if (++nodes > 100_000 || depth > 80) throw new Error('OpenAPI document exceeds the supported complexity limit.');
    if (Array.isArray(value)) return value.map(item => visit(item, refs, depth + 1));
    if (!object(value)) return value;
    for (const key of Object.keys(value)) {
      if (unsafeKeys.has(key)) throw new Error(`Unsafe object key: ${key}.`);
    }
    if ('$ref' in value) {
      const ref = value.$ref;
      if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new Error('Only local #/ JSON pointer references are supported.');
      if (refs.has(ref)) throw new Error(`Circular reference is not supported: ${ref}.`);
      let target: unknown = root;
      for (const raw of ref.slice(2).split('/')) {
        const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
        if (unsafeKeys.has(key) || (!object(target) && !Array.isArray(target)) || !Object.hasOwn(target, key)) throw new Error(`Unresolved reference: ${ref}.`);
        target = (target as Record<string, unknown>)[key];
      }
      const next = new Set(refs).add(ref);
      const resolved = assertObject(visit(target, next, depth + 1), `Reference ${ref}`);
      const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref'));
      return { ...resolved, ...assertObject(visit(siblings, refs, depth + 1), 'Reference siblings') };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, refs, depth + 1)]));
  }
  return assertObject(visit(root, new Set(), 0), 'OpenAPI document');
}

/** Convert OpenAPI 3.0 nullable schemas into JSON Schema accepted by MCP clients. */
function jsonSchema(value: unknown): JsonSchema {
  if (value === true) return {};
  if (value === false) return { not: {} };
  const source = assertObject(value ?? {}, 'Parameter schema');
  const output: JsonSchema = {};
  for (const [key, entry] of Object.entries(source)) {
    if (['nullable', 'example', 'xml', 'discriminator', 'externalDocs'].includes(key)) continue;
    if (['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas'].includes(key) && object(entry)) {
      output[key] = Object.fromEntries(Object.entries(entry).map(([name, schema]) => [name, jsonSchema(schema)]));
    } else if (['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties'].includes(key) && (object(entry) || typeof entry === 'boolean')) {
      output[key] = jsonSchema(entry);
    } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key) && Array.isArray(entry)) {
      output[key] = entry.map(jsonSchema);
    } else if ((key === 'exclusiveMinimum' || key === 'exclusiveMaximum') && typeof entry === 'boolean') {
      const boundary = source[key === 'exclusiveMinimum' ? 'minimum' : 'maximum'];
      if (entry && typeof boundary === 'number') output[key] = boundary;
    } else output[key] = entry;
  }
  if (typeof source.exclusiveMinimum === 'boolean' && source.exclusiveMinimum) delete output.minimum;
  if (typeof source.exclusiveMaximum === 'boolean' && source.exclusiveMaximum) delete output.maximum;
  if (source.nullable === true) {
    if (typeof output.type === 'string') output.type = [output.type, 'null'];
    else if (Array.isArray(output.type)) output.type = [...new Set([...output.type, 'null'])];
    else return { anyOf: [output, { type: 'null' }] };
    if (Array.isArray(output.enum) && !output.enum.includes(null)) output.enum = [...output.enum, null];
  }
  return output;
}

function serverUrl(servers: unknown): string | undefined {
  if (!Array.isArray(servers) || !servers.length) return undefined;
  const server = assertObject(servers[0], 'Server');
  if (typeof server.url !== 'string') throw new Error('OpenAPI server must have a URL.');
  let url = server.url;
  const variables = object(server.variables) ? server.variables : {};
  url = url.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const variable = assertObject(variables[name], `Server variable ${name}`);
    if (typeof variable.default !== 'string') throw new Error(`Server variable ${name} needs a string default.`);
    return variable.default;
  });
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('OpenAPI servers must use absolute HTTP(S) URLs.'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error('OpenAPI server must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  return url.replace(/\/$/, '');
}

function normalizedName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 58) || 'api_tool';
}

/** Import OpenAPI 3.0/3.1 JSON (or an already parsed YAML document) atomically. */
export function importOpenApi(input: unknown): EndpointInput[] {
  const spec = resolveDocument(input);
  if (typeof spec.openapi !== 'string' || !/^3\.(0|1)\./.test(spec.openapi)) throw new Error('OpenAPI 3.0 or 3.1 is required.');
  const paths = assertObject(spec.paths, 'OpenAPI paths');
  const endpoints: EndpointInput[] = [];
  const names = new Set<string>();
  for (const [path, pathValue] of Object.entries(paths)) {
    if (!path.startsWith('/') || path.includes('?') || path.includes('#')) throw new Error(`Invalid OpenAPI path: ${path}.`);
    const pathItem = assertObject(pathValue, `Path ${path}`);
    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (method === 'trace' || method === 'options') throw new Error(`${method.toUpperCase()} operations are not supported.`);
      if (!methods.has(method)) continue;
      const operation = assertObject(operationValue, `${method.toUpperCase()} ${path}`);
      const base = serverUrl(operation.servers) ?? serverUrl(pathItem.servers) ?? serverUrl(spec.servers);
      if (!base) throw new Error(`An absolute server URL is required for ${method.toUpperCase()} ${path}.`);
      const baseName = normalizedName(typeof operation.operationId === 'string' ? operation.operationId : `${method}_${path}`);
      let name = baseName;
      let suffix = 2;
      while (names.has(name)) name = `${baseName}_${suffix++}`;
      names.add(name);
      const merged = new Map<string, ObjectValue>();
      for (const collection of [pathItem.parameters, operation.parameters]) {
        if (collection !== undefined && !Array.isArray(collection)) throw new Error(`Parameters for ${name} must be an array.`);
        for (const entry of (collection ?? []) as unknown[]) {
          const param = assertObject(entry, `Parameter for ${name}`);
          if (typeof param.name !== 'string' || !param.name || unsafeKeys.has(param.name)) throw new Error(`Invalid parameter name for ${name}.`);
          if (!['path', 'query', 'header'].includes(String(param.in))) throw new Error(`Parameter location ${String(param.in)} is unsupported; use path, query, or header.`);
          merged.set(`${param.in}:${param.name}`, param);
        }
      }
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      const parameters: ParameterMapping[] = [];
      for (const param of merged.values()) {
        const paramName = param.name as string;
        const location = param.in as ParameterMapping['in'];
        if (location === 'header' && /^(host|connection|content-length|transfer-encoding|authorization|proxy-authorization|cookie|set-cookie|forwarded|x-forwarded-.*)$/i.test(paramName)) {
          throw new Error(`Header parameter ${paramName} is protected. Configure upstream credentials on the endpoint instead.`);
        }
        if ('content' in param) throw new Error(`Content-encoded parameter ${paramName} is unsupported. Use a schema parameter.`);
        const style = typeof param.style === 'string' ? param.style : location === 'query' ? 'form' : 'simple';
        const allowed = location === 'query' ? ['form', 'spaceDelimited', 'pipeDelimited', 'deepObject'] : ['simple'];
        if (!allowed.includes(style)) throw new Error(`Unsupported ${location} parameter style ${style} for ${paramName}.`);
        if (param.allowReserved === true) throw new Error(`allowReserved is unsupported for ${paramName}; values are always safely encoded.`);
        let inputProperty = paramName;
        if (Object.hasOwn(properties, inputProperty)) inputProperty = `${location}_${paramName}`;
        while (Object.hasOwn(properties, inputProperty)) inputProperty = `_${inputProperty}`;
        const schema = jsonSchema(param.schema);
        if (['spaceDelimited', 'pipeDelimited'].includes(style) && schema.type !== 'array') throw new Error(`${style} requires an array schema for ${paramName}.`);
        if (style === 'deepObject' && schema.type !== 'object') throw new Error(`deepObject requires an object schema for ${paramName}.`);
        if (typeof param.description === 'string') schema.description = param.description;
        properties[inputProperty] = schema;
        const isRequired = location === 'path' || param.required === true;
        if (isRequired) required.push(inputProperty);
        parameters.push({ name: paramName, in: location, required: isRequired, inputProperty, style: style as ParameterMapping['style'], explode: typeof param.explode === 'boolean' ? param.explode : style === 'form' });
      }
      for (const match of path.matchAll(/\{([^}]+)\}/g)) {
        if (!parameters.some(param => param.in === 'path' && param.name === match[1])) throw new Error(`Path parameter ${match[1]} is missing a definition for ${name}.`);
      }
      let bodyProperty: string | undefined;
      let bodyContentType: string | undefined;
      if (operation.requestBody !== undefined) {
        if (method === 'get' || method === 'head') throw new Error(`Request bodies for ${method.toUpperCase()} operations are unsupported.`);
        const requestBody = assertObject(operation.requestBody, `Request body for ${name}`);
        const content = assertObject(requestBody.content, `Request body content for ${name}`);
        const mediaType = Object.keys(content).find(type => type === 'application/json') ?? Object.keys(content).find(type => /^application\/[\w.+-]+\+json$/.test(type));
        if (!mediaType) throw new Error(`Only JSON request bodies are supported for ${name}.`);
        bodyContentType = mediaType;
        const media = assertObject(content[mediaType], `Media type ${mediaType}`);
        bodyProperty = 'body';
        while (Object.hasOwn(properties, bodyProperty)) bodyProperty = `_${bodyProperty}`;
        properties[bodyProperty] = jsonSchema(media.schema);
        if (requestBody.required === true) required.push(bodyProperty);
      }
      endpoints.push({ name, description: String(operation.summary ?? operation.description ?? `${method.toUpperCase()} ${path}`).slice(0, 2000), method: method.toUpperCase() as HttpMethod, url: `${base}${path}`, enabled: true, inputSchema: { type: 'object', properties, required, additionalProperties: false }, parameters, ...(bodyProperty ? { bodyProperty } : {}), kind: 'rest', headers: bodyContentType ? { 'content-type': bodyContentType } : {} });
    }
  }
  if (!endpoints.length) throw new Error('The specification has no supported HTTP operations.');
  if (endpoints.length > 500) throw new Error('Import at most 500 operations at a time.');
  return endpoints;
}
