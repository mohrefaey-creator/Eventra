// Typed validation of item responses. Server-side only; the client is never trusted.
export class ValidationError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

/** Returns the normalized response value, or throws ValidationError. */
export function validateResponse(item, raw) {
  switch (item.response_type) {
    case 'likert_5': {
      const n = typeof raw === 'string' && /^[1-5]$/.test(raw) ? Number(raw) : raw;
      if (!Number.isInteger(n) || n < 1 || n > 5) throw new ValidationError('invalid_response', 'Expected an integer from 1 to 5.');
      return n;
    }
    case 'likert_5_na': {
      if (raw === 'na') return 'na';
      const n = typeof raw === 'string' && /^[1-5]$/.test(raw) ? Number(raw) : raw;
      if (!Number.isInteger(n) || n < 1 || n > 5) throw new ValidationError('invalid_response', "Expected an integer from 1 to 5, or 'na'.");
      return n;
    }
    case 'single_choice': {
      if (typeof raw !== 'string' || !item.options.includes(raw)) throw new ValidationError('invalid_response', 'Value is not one of the allowed options.');
      return raw;
    }
    default:
      throw new ValidationError('unsupported_response_type', item.response_type);
  }
}

/** Evidence entry validation (academic evidence is manual and unverified until a counselor verifies it). */
export const EVIDENCE_TYPES = {
  secondary_percentage: { kind: 'number', min: 0, max: 100 },
  gat: { kind: 'number', min: 0, max: 100 }, // Qudrat / General Aptitude Test (score scale placeholder 0-100)
  saat: { kind: 'number', min: 0, max: 100 }, // Tahsili / Standard Achievement Admission Test (placeholder 0-100)
  pathway: { kind: 'enum', values: ['general', 'health_life', 'cs_engineering', 'business_admin', 'sharia'] },
};
export const GRADE_SUBJECTS = ['math', 'physics', 'chemistry', 'biology', 'computer', 'english', 'arabic'];
for (const s of GRADE_SUBJECTS) EVIDENCE_TYPES[`subject_grade:${s}`] = { kind: 'number', min: 0, max: 100 };

/** Accept Arabic-Indic / Persian digits and Arabic decimal separators typed by a student. */
export function normalizeDigits(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫،]/g, '.')
    .trim();
}

export function validateEvidenceValue(type, raw) {
  // own properties only: "constructor", "__proto__" etc. must not look like evidence types
  const spec = typeof type === 'string' && Object.hasOwn(EVIDENCE_TYPES, type) ? EVIDENCE_TYPES[type] : undefined;
  if (!spec) throw new ValidationError('unknown_evidence_type', 'Unknown evidence type.');
  if (spec.kind === 'enum') {
    if (!spec.values.includes(raw)) throw new ValidationError('invalid_evidence_value', `Allowed: ${spec.values.join(', ')}`);
    return raw;
  }
  const n = typeof raw === 'string' ? Number(normalizeDigits(raw)) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < spec.min || n > spec.max) {
    throw new ValidationError('invalid_evidence_value', `Expected a number from ${spec.min} to ${spec.max}.`);
  }
  return Math.round(n * 100) / 100;
}
