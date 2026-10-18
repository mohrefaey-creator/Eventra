import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELIGIBILITY } from '../../domain/admission/gate.js';
import { INSTRUMENT_STATES, INSTRUMENTS } from '../../domain/instruments/registry.js';
import { SUBJECTS, SKILLS, VALUES } from '../../domain/instruments/others.js';
import { RIASEC_DIMENSIONS } from '../../domain/instruments/interest.js';
import { PATHWAYS } from '../../domain/catalog/programs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const en = JSON.parse(fs.readFileSync(path.join(root, 'i18n/en.json'), 'utf8'));
const ar = JSON.parse(fs.readFileSync(path.join(root, 'i18n/ar-SA.json'), 'utf8'));

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const sources = walk(path.join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(f, 'utf8')]);
const tokens = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('both dictionaries have exactly the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ar).sort());
});

test('no value is empty and Arabic values are not copies of English (except language names / separators)', () => {
  const allowed = new Set(['lang.switch', 'missing.evidence']);
  for (const [k, v] of Object.entries(en)) {
    assert.ok(v !== '' || k === 'common.list_sep' || false, `empty en ${k}`);
    assert.ok(ar[k] !== '', `empty ar ${k}`);
    if (!allowed.has(k) && /[A-Za-z]{4,}/.test(v)) assert.notEqual(ar[k], v, `untranslated ${k}`);
  }
});

test('placeholders match between languages', () => {
  for (const k of Object.keys(en)) assert.deepEqual(tokens(ar[k]), tokens(en[k]), `placeholders differ for ${k}`);
});

/** Top-level keys of an object literal starting at src[i] === '{' (handles nesting, strings, templates). */
function topLevelKeys(src, i) {
  const keys = [];
  let depth = 0;
  let quote = null;
  let start = i + 1;
  const flush = (end) => {
    const part = src.slice(start, end).trim();
    if (part) keys.push(/^(['"]?)([\w.]+)\1\s*(?::|$)/.exec(part)?.[2] ?? part);
  };
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === '\\') j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) {
      depth--;
      if (depth === 0) {
        flush(j);
        return keys;
      }
    } else if (c === ',' && depth === 1) {
      flush(j);
      start = j + 1;
    }
  }
  return keys;
}

test('every static t("key") used by the UI exists, and its params exist as placeholders', () => {
  const missing = [];
  const badParams = [];
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/\bt\(\s*(['"`])([^'"`$]+?)\1\s*(,\s*)?(\{)?/g)) {
      const key = m[2];
      if (!(key in en)) {
        missing.push(`${path.basename(file)}: ${key}`);
        continue;
      }
      if (m[4]) {
        const braceAt = m.index + m[0].length - 1;
        for (const name of topLevelKeys(src, braceAt)) {
          if (!tokens(en[key]).includes(name)) badParams.push(`${path.basename(file)}: ${key} passes {${name}} but the text has ${JSON.stringify(tokens(en[key]))}`);
        }
      }
    }
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(badParams, []);
});

test('dynamic key families cover every domain enumeration the UI can emit', () => {
  const need = [];
  for (const e of ELIGIBILITY) need.push(`elig.${e}`, `advisor.admission.${e}`);
  for (const s of INSTRUMENT_STATES) need.push(`instr.state.${s}`);
  for (const d of RIASEC_DIMENSIONS) need.push(`dim.${d}.name`, `dim.${d}.blurb`);
  for (const k of Object.keys(SUBJECTS)) need.push(`subj.${k}`);
  for (const k of Object.keys(SKILLS)) need.push(`skill.${k}`);
  for (const k of Object.keys(VALUES)) need.push(`value.${k}`);
  for (const k of Object.keys(PATHWAYS)) need.push(`pathway.${k}`);
  for (const i of INSTRUMENTS) for (const k of Object.keys(i.governance.validation)) need.push(`instr.val.${k}`);
  for (const k of ['assessment_processing', 'counselor_sharing', 'guardian_summary_sharing', 'advisor_explanation', 'aggregate_analytics']) need.push(`scope.${k}.title`, `scope.${k}.body`);
  for (const k of ['verified_current', 'stale', 'conflicting', 'none', 'not_published']) need.push(`source.${k}`);
  for (const k of ['met', 'not_met', 'unknown', 'unverified_met', 'unverified_not_met']) need.push(`cond.${k}`);
  for (const k of ['not_evaluated', 'source_conflict', 'source_stale', 'ineligible', 'missing_evidence', 'needs_verification', 'eligible']) need.push(`adm.msg.${k}`);
  for (const k of ['module_completed', 'profile_updated', 'majors_explored', 'report_approved', 'consent_withdrawn']) need.push(`journey.${k}`);
  for (const k of ['top_interests_resonate', 'surprises', 'subjects_vs_interests', 'which_documents', 'verify_scores', 'alternatives', 'readiness_plan']) need.push(`q.${k}`);
  for (const k of ['instruction_language_mismatch', 'preparation_gap', 'admission_condition_not_met']) need.push(`tension.${k}`, `advisor.tension.${k}`);
  for (const k of ['low_interest_not_inability', 'not_holland_code', 'no_norms', 'no_acceptance_probability']) need.push(`advisor.${k}`);
  for (const k of ['no_items_defined', 'license_not_confirmed', 'translation_review_missing', 'back_translation_missing', 'expert_review_missing', 'cognitive_interviews_missing', 'reliability_missing', 'fairness_findings_missing', 'instrument_retired']) need.push(`blocker.${k}`);
  for (const k of ['cross_tenant', 'not_self', 'role_not_permitted', 'consent_required', 'consent_processing_inactive', 'consent_scope_inactive', 'no_guardian_relationship', 'not_assigned_counselor', 'report_not_shared', 'four_eyes_required', 'guardian_scope_not_permitted']) need.push(`deny.${k}`);
  for (const k of ['unreviewed', 'missing_consent', 'ambiguous_profile', 'unverified_evidence', 'stale_catalog', 'safeguarding_referral', 'appeal', 'interpretation_dispute', 'help_request', 'parent_inquiry', 'report_review', 'follow_up', 'none']) need.push(`queue.reason.${k}`);
  for (const k of ['help_request', 'appeal', 'interpretation_dispute', 'safeguarding_referral', 'parent_inquiry', 'follow_up', 'report_review', 'unverified_evidence']) need.push(`case.reason.${k}`);
  for (const k of ['draft', 'review_requested', 'approved', 'rejected']) need.push(`report.status.${k}`);
  for (const k of ['interest_unvalidated', 'no_norms_or_percentiles', 'aptitude_on_hold', 'not_an_admission_decision', 'fictional_catalog']) need.push(`limit.${k}`);
  for (const k of ['not_started', 'in_progress', 'completed', 'needs_review', 'unavailable']) need.push(`module.status.${k}`);
  for (const k of ['riasec_dimension_incomplete', 'flat_interest_profile', 'flat_program_profile']) need.push(`fit.reason.${k}`);
  for (const k of ['not_required', 'evidence_missing', 'provisional', 'assessed']) need.push(`readiness.${k}`);
  for (const k of ['eligibility', 'rule_snapshot', 'interest_fit', 'readiness']) need.push(`change.${k}`);
  for (const k of ['instrument_on_hold', 'instrument_suspended', 'instrument_retired', 'license_expired', 'not_approved_for_live_use', 'unknown_instrument']) need.push(`instr.unusable.${k}`);
  for (const r of ['student', 'guardian', 'counselor', 'catalog_steward', 'psychometric_lead', 'tenant_admin', 'platform_security']) need.push(`role.${r}`, `role.${r}.plural`);
  for (const k of ['overview', 'results', 'evidence', 'recos', 'cases', 'notes', 'reports', 'raw']) need.push(`c360.tab.${k}`);
  for (const k of ['home', 'dashboard', 'results', 'majors', 'roadmap', 'report', 'help', 'settings', 'guardian', 'queue', 'instruments', 'catalog', 'control']) need.push(`nav.${k}`);
  assert.deepEqual(need.filter((k) => !(k in en)), []);
});

test('UI markup has no inline event handlers or inline styles (CSP-safe)', () => {
  for (const [file, src] of sources) {
    assert.doesNotMatch(src, /\son(click|change|submit|load|error|input)\s*=/i, `${path.basename(file)} has an inline handler`);
    assert.doesNotMatch(src, /\sstyle\s*=\s*["'`]/i, `${path.basename(file)} has an inline style`);
    if (path.basename(file) !== 'html.js') assert.doesNotMatch(src, /\binnerHTML\s*=/, `${path.basename(file)} assigns innerHTML directly (use mount)`);
    assert.doesNotMatch(src, /\beval\(|new Function\(/, `${path.basename(file)} uses eval`);
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
});

test('html helper: values are escaped, arrays of safe fragments are not, user text cannot inject markup', async () => {
  const { h, toHtml, raw } = await import('../../web/js/html.js');
  const evil = '<img src=x onerror=alert(1)>"\'`&';
  assert.equal(toHtml(h`<p>${evil}</p>`), '<p>&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&#96;&amp;</p>');
  const list = [1, 2].map((n) => h`<li>${n}</li>`);
  assert.equal(toHtml(list), '<li>1</li><li>2</li>', 'an array of fragments renders as HTML');
  assert.equal(toHtml(h`<ul>${list}</ul>`), '<ul><li>1</li><li>2</li></ul>');
  assert.equal(toHtml(h`${false}${null}${undefined}x`), 'x');
  assert.equal(toHtml(evil), '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&#96;&amp;', 'plain strings passed to mount are escaped');
  assert.equal(toHtml(h`${raw('<b>ok</b>')}`), '<b>ok</b>');
  assert.equal(toHtml(h`<a href="${'" onclick="x'}">`), '<a href="&quot; onclick=&quot;x">', 'attribute injection is neutralised');
});

test('boolean ARIA attributes are never interpolated as bare booleans (they would render empty)', () => {
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/aria-(pressed|selected|checked|expanded|current)="\$\{([^}]*)\}"/g)) {
      assert.match(m[2], /\?\s*['"]|String\(/, `${path.basename(file)}: aria-${m[1]}="\${${m[2]}}" would render an empty attribute`);
    }
  }
});

test('docs/06_API.md lists every registered route (documentation cannot drift from the code)', async () => {
  const { registerRoutes } = await import('../../server/routes.js');
  const found = [];
  registerRoutes({ add: (method, pattern) => found.push(`${method} ${pattern}`) }, { sessions: {}, clock: () => new Date() });
  const doc = fs.readFileSync(path.resolve(root, '../docs/06_API.md'), 'utf8');
  const norm = (p) => p.replace('/api/v1/discovery', '');
  const missing = found.filter((r) => {
    const [m, p] = r.split(' ');
    return !doc.includes(`${m} ${norm(p)}`);
  });
  assert.deepEqual(missing, []);
  assert.ok(found.length >= 55);
});
