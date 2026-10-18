// Pure helpers shared by scoring, matching and the server. No I/O.
import { createHash } from 'node:crypto';

/** Deterministic JSON: sorted object keys, undefined dropped, non-finite numbers rejected. */
export function canonicalize(value) {
  return JSON.stringify(normalize(value));
}

function normalize(v) {
  if (v === null) return null;
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : normalize(x)));
  switch (typeof v) {
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('canonicalize: non-finite number');
      return v;
    case 'string':
    case 'boolean':
      return v;
    case 'object': {
      const out = Object.create(null); // own '__proto__' keys must be hashed, not swallowed by the prototype setter
      for (const k of Object.keys(v).sort()) {
        if (v[k] !== undefined) out[k] = normalize(v[k]);
      }
      return out;
    }
    default:
      throw new TypeError(`canonicalize: unsupported type ${typeof v}`);
  }
}

/** Lookup that only sees own properties, so ids such as "constructor" or "__proto__" are simply absent. */
export const own = (obj, key) => (obj && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined);

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function hashOf(value) {
  return sha256(canonicalize(value));
}

/** Decimal rounding that avoids binary-float drift (round(1.005, 2) === 1.01). */
export function round(x, digits = 6) {
  if (x === null || x === undefined) return x;
  return Number(`${Math.round(Number(`${x}e${digits}`))}e-${digits}`);
}

export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
