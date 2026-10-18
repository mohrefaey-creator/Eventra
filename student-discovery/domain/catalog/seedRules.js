// Builds the seed admission_rule_snapshot rows relative to a reference date, so the demo never
// silently ages into "everything is stale". FICTIONAL thresholds, FICTIONAL publisher.
import { PROGRAMS, SEED_RULE_EXCEPTIONS } from './programs.js';

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString();

export function buildRuleConditions([pathways, secondary, gat, saat]) {
  const conditions = [{ key: 'pathway', op: 'in', value: pathways }];
  if (secondary !== null) conditions.push({ key: 'secondary_percentage', op: 'gte', value: secondary });
  if (gat !== null) conditions.push({ key: 'gat', op: 'gte', value: gat });
  if (saat !== null) conditions.push({ key: 'saat', op: 'gte', value: saat });
  return conditions;
}

export function buildSeedRuleSnapshots(now, idGen) {
  const t = now.getTime();
  const out = [];
  for (const p of PROGRAMS) {
    const exception = SEED_RULE_EXCEPTIONS[p.program_id];
    if (exception === 'none') continue;
    const stale = exception === 'stale';
    const conflicting = exception === 'conflicting';
    out.push({
      id: idGen(),
      program_id: p.program_id,
      cycle: '2027',
      version: 1,
      state: conflicting ? 'conflicting' : 'published',
      rules: { conditions: buildRuleConditions(p.rule), competitive: true, application_window: { opens: iso(t - 30 * DAY), closes: iso(t + 120 * DAY) } },
      source: {
        publisher: 'Demo University Admissions Office (fictional)',
        source_url: `https://example.invalid/demo-admissions/${p.program_id}/2027`,
        published_at: iso(t - 90 * DAY),
        captured_at: iso(t - 60 * DAY),
      },
      effective_from: iso(t - 60 * DAY),
      effective_to: iso(t + 300 * DAY),
      review_due_at: stale ? iso(t - 12 * DAY) : iso(t + 120 * DAY),
      authored_by: 'user-steward-1',
      verified_by: 'user-steward-2',
      conflict_detail: conflicting
        ? { note: 'Two fictional publishers state different minimum GAT values (70 vs 75).', alternatives: [{ publisher: 'Publisher X (fictional)', gat: 70 }, { publisher: 'Publisher Y (fictional)', gat: 75 }] }
        : null,
      supersedes_id: null,
      created_at: iso(t - 60 * DAY),
      published_at: iso(t - 55 * DAY),
    });
  }
  return out;
}
