// Policy PLACEHOLDERS. Every value here needs an accountable owner's decision before it can be
// treated as policy (spec §16: D-04, D-05, D-08, D-10). They exist so behaviour is configurable,
// testable and visible, not because they are approved.
export const POLICY = Object.freeze({
  policy_version: 'consent-policy-DEMO-0.1',
  legal_basis_ref: 'PENDING-COUNSEL-REVIEW',
  guardian_required_below_age: 18, // D-05
  min_cell_size: 5, // aggregate suppression threshold (spec DISC-14)
  retake: Object.freeze({ min_days_between: 0, max_attempts: 5 }),
  report_share_default_days: 30,
  report_share_max_days: 90,
  rate_limit_per_minute: 300,
  login_limit_per_minute: 30, // per client address; test harnesses that sign in constantly raise it
  session_ttl_ms: 8 * 3600 * 1000,
  body_limit_bytes: 64 * 1024,
});

export const CONSENT_SCOPES = Object.freeze({
  assessment_processing: Object.freeze({ required: true }),
  counselor_sharing: Object.freeze({ required: false }),
  raw_answer_sharing: Object.freeze({ required: false }), // a distinct visibility class (spec §11.7)
  guardian_summary_sharing: Object.freeze({ required: false }),
  advisor_explanation: Object.freeze({ required: false }),
  aggregate_analytics: Object.freeze({ required: false }),
});

export function loadConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 4180),
    dataFile: env.DATA_FILE === undefined ? new URL('../data/db.json', import.meta.url).pathname : env.DATA_FILE || null,
    // Exploratory instruments may only be used while this is true (fail closed otherwise).
    syntheticMode: env.SYNTHETIC_MODE !== 'false',
    // The persona stand-in is not authentication. Serving non-loopback hosts must be an explicit, loud opt-in.
    allowAnyHost: env.ALLOW_NETWORK_HOST === 'true',
    // Optional: PDF export needs an installed Chromium/Chrome. Without one the export route answers 501.
    chromiumPath: env.CHROMIUM_PATH || null,
  };
}
