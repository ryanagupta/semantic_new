import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import formatsModule, { type FormatsPlugin } from 'ajv-formats';
import type { Endpoint } from '../../shared/types.js';

const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: true });
(formatsModule as unknown as FormatsPlugin)(ajv);
const sanitizingAjv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false, removeAdditional: true, validateFormats: true });
(formatsModule as unknown as FormatsPlugin)(sanitizingAjv);
const validators = new Map<string, ValidateFunction>();

export function argumentValidator(endpoint: Pick<Endpoint, 'inputSchema' | 'name'>, sanitize = false): ValidateFunction {
  const serialized = JSON.stringify(endpoint.inputSchema);
  if (serialized.length > 200_000) throw new Error('Tool input schema exceeds 200 KB.');
  const cacheKey = `${sanitize ? 'sanitize:' : 'validate:'}${serialized}`;
  let validator = validators.get(cacheKey);
  if (!validator) {
    let nodes = 0;
    const inspect = (value: unknown, depth: number) => {
      if (++nodes > 20_000 || depth > 40) throw new Error('Input schema exceeds complexity limits.');
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(item => inspect(item, depth + 1)); return; }
      for (const [key, item] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe schema property.');
        if ((key === '$ref' || key === '$dynamicRef') && (typeof item !== 'string' || !item.startsWith('#'))) throw new Error('External schema references are forbidden.');
        inspect(item, depth + 1);
      }
    };
    inspect(endpoint.inputSchema, 0);
    const schema = structuredClone(endpoint.inputSchema);
    // A draft-07 declaration does not change the supported common validation vocabulary.
    if (typeof schema.$schema === 'string' && schema.$schema.includes('draft-07')) delete schema.$schema;
    validator = (sanitize ? sanitizingAjv : ajv).compile(schema);
    if (validators.size >= 500) validators.delete(validators.keys().next().value!);
    validators.set(cacheKey, validator);
  }
  return validator;
}

export function validateArguments(endpoint: Pick<Endpoint, 'inputSchema' | 'name'>, args: Record<string, unknown>): void {
  const validator = argumentValidator(endpoint);
  if (!validator(args)) {
    throw new Error(`Invalid arguments for ${endpoint.name}: ${ajv.errorsText(validator.errors, { separator: '; ' })}`);
  }
}
