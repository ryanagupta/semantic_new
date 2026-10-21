import type { Endpoint } from '../../shared/types.js';
import { argumentValidator, validateArguments } from '../bridge/validation.js';
import { z } from 'zod';

function inspectStrings(value: unknown, depth = 0): void {
  if (depth > 30) throw new Error('Tool arguments exceed the maximum nesting depth.');
  if (typeof value === 'string') {
    let decoded = value;
    for (let pass = 0; pass < 2; pass++) {
      try { decoded = decodeURIComponent(decoded); } catch { break; }
    }
    if (/[|;&$><`\x00]/.test(decoded)) throw new Error('Tool arguments contain a forbidden command delimiter.');
    if (/\bunion\s+(?:all\s+)?select\b|--|\b1\s*=\s*1\b/i.test(decoded)) throw new Error('Tool arguments contain a forbidden SQL injection pattern.');
    if (/\.\.[/\\]/.test(decoded)) throw new Error('Tool arguments contain a forbidden directory traversal pattern.');
  } else if (Array.isArray(value)) value.forEach(item => inspectStrings(item, depth + 1));
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe argument property.');
      inspectStrings(item, depth + 1);
    }
  }
}

/** Only declared, mapped arguments survive. The result is a detached object. */
export function sanitizeArguments(endpoint: Endpoint, args: Record<string, unknown>): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.');
  const serialized = JSON.stringify(args);
  if (Buffer.byteLength(serialized) > 1_048_576) throw new Error('Tool arguments exceed 1 MB.');
  const clean: Record<string, unknown> = JSON.parse(serialized);
  const mapped = new Set(endpoint.parameters.map(parameter => parameter.inputProperty ?? parameter.name));
  if (endpoint.bodyProperty) mapped.add(endpoint.bodyProperty);
  if (endpoint.kind === 'graphql' && !endpoint.bodyProperty) ['query', 'variables', 'operationName'].forEach(name => mapped.add(name));
  for (const key of Object.keys(clean)) if (!mapped.has(key)) delete clean[key];
  const validator = argumentValidator(endpoint, true);
  const dynamicSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
    if (!validator(value)) context.addIssue({ code: 'custom', message: `Tool argument validation failed: ${JSON.stringify(validator.errors)}` });
  });
  const sanitized = dynamicSchema.parse(clean);
  validateArguments(endpoint, sanitized);
  inspectStrings(sanitized);
  return sanitized;
}
