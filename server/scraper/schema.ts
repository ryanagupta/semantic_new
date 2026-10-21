import { Ajv } from 'ajv';
import { HttpError } from '../errors.js';

export type OutputSchema = Record<string, unknown>;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
function unique(schemas: OutputSchema[]) {
  return [...new Map(schemas.map(s => [JSON.stringify(s), s])).values()];
}
function combine(schemas: OutputSchema[]): OutputSchema {
  const distinct = unique(schemas);
  if (distinct.length === 1) return distinct[0];
  const nonNull = distinct.filter(s => !(Array.isArray(s.enum) && s.enum.length === 1 && s.enum[0] === null));
  if (nonNull.length === 1 && nonNull.length !== distinct.length) return { ...nonNull[0], nullable: true };
  return { anyOf: distinct };
}

/** Infer every sampled array element, preserving optional properties and mixed item types. */
export function inferOutputSchema(value: unknown, depth = 0): OutputSchema {
  if (depth > 15) throw new HttpError(422, 'Scraped output is too deeply nested.');
  if (value === null) return { type: 'string', nullable: true, enum: [null] };
  if (typeof value === 'string') return { type: 'string' };
  if (typeof value === 'number' && Number.isFinite(value)) return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (Array.isArray(value)) {
    if (value.length > 200) throw new HttpError(422, 'Scrapers may return at most 200 items per array.');
    if (!value.length) return { type: 'array', items: {} };
    if (value.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
      const records = value as Record<string, unknown>[];
      const keys = [...new Set(records.flatMap(Object.keys))];
      if (keys.length > 100) throw new HttpError(422, 'Too many output properties.');
      const properties = Object.fromEntries(keys.map(key => {
        if (forbidden.has(key)) throw new HttpError(422, 'Unsafe output property.');
        return [key, combine(records.filter(r => Object.hasOwn(r, key)).map(r => inferOutputSchema(r[key], depth + 1)))];
      }));
      return { type: 'array', items: { type: 'object', properties, required: keys.filter(k => records.every(r => Object.hasOwn(r, k))), additionalProperties: false } };
    }
    return { type: 'array', items: combine(value.map(item => inferOutputSchema(item, depth + 1))) };
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > 100) throw new HttpError(422, 'Too many output properties.');
    return { type: 'object', properties: Object.fromEntries(entries.map(([key, item]) => {
      if (forbidden.has(key)) throw new HttpError(422, 'Unsafe output property.');
      return [key, inferOutputSchema(item, depth + 1)];
    })), required: entries.map(([key]) => key), additionalProperties: false };
  }
  throw new HttpError(422, 'Scraper must return JSON-compatible values.');
}

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.some(hasContent);
  if (value && typeof value === 'object') return Object.values(value).some(hasContent);
  return true;
}
export function verifyOutput(value: unknown, requiredFields: string[] = []) {
  if (!value || typeof value !== 'object' || !hasContent(value)) throw new HttpError(422, 'No usable records were extracted. Check the selectors.');
  const candidates = Array.isArray(value) ? value : [value];
  if (requiredFields.length && !candidates.every(row => row && typeof row === 'object' && requiredFields.every(field => Object.hasOwn(row, field)))) {
    throw new HttpError(422, 'The extracted records are missing the requested output fields.');
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 1048576) throw new HttpError(422, 'Scraped output exceeds 1 MB.');
  return inferOutputSchema(value);
}
export function validateStoredOutput(schema: OutputSchema, value: unknown) {
  // Normalize OAS nullable-only nodes to JSON Schema null, then validate drift at runtime.
  function normalize(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(normalize);
    if (!node || typeof node !== 'object') return node;
    const object = node as Record<string, unknown>;
    if (object.nullable === true && !object.type) return { type: 'null' };
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, normalize(item)]));
  }
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
  if (!ajv.validate(normalize(schema) as object, value)) throw new HttpError(502, 'The source changed: scraped output no longer matches the verified schema. Rebuild this scraper.');
  verifyOutput(value);
}
