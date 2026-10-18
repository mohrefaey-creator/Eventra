// A deliberately small persistence layer for the local prototype: one JSON document, atomic
// writes, all-or-nothing transactions. Production uses PostgreSQL (spec §6.1); the shape of the
// collections below mirrors the proposed relational model (spec §7).
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

export function emptyDb() {
  return {
    meta: { schema_version: SCHEMA_VERSION, seeded_at: null, kill_switch: { enabled: false, reason: null, by: null, at: null } },
    users: {},
    guardian_links: [],
    counselor_assignments: [],
    consent_records: {},
    instrument_state: {},
    sessions: {},
    responses: {}, // `${session_id}:${item_id}` -> response
    score_runs: {},
    evidence: {},
    preferences: {}, // `${student_id}:${category}` -> preference
    aspirations: {}, // `${student_id}:${program_id}` -> aspiration
    programs: {},
    rule_snapshots: {},
    recommendation_runs: {},
    cases: {},
    case_notes: {},
    overrides: {},
    reports: {},
    approvals: {},
    shares: {},
    retention_tasks: {},
    journey: {}, // student_id -> milestones
    idempotency: {},
    audit: [],
    outbox: [],
  };
}

export function createStore({ file = null } = {}) {
  let db = emptyDb();
  if (file && fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded?.meta?.schema_version !== SCHEMA_VERSION) throw new Error(`Unsupported database schema in ${file}; run "npm run reset".`);
    db = { ...emptyDb(), ...loaded };
  }

  function persist() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file);
  }

  /** Run fn against the live db; on throw, restore the pre-call state (all-or-nothing). */
  function tx(fn) {
    const backup = structuredClone(db);
    try {
      const out = fn(db);
      persist();
      return out;
    } catch (e) {
      for (const k of Object.keys(db)) delete db[k];
      Object.assign(db, backup);
      throw e;
    }
  }

  return {
    get db() {
      return db;
    },
    tx,
    persist,
    reset() {
      db = emptyDb();
    },
  };
}
