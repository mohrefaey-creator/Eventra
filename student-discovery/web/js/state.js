// Tiny shared client state. Nothing sensitive is persisted in the browser.
export const state = {
  me: null, // { persona, csrf_token, linked_students, incident_mode, synthetic_mode, policy }
};

export const role = () => state.me?.persona?.role ?? null;
export const myId = () => state.me?.persona?.id ?? null;

/** The student whose data the current screen is about. */
export function activeStudentId(params = {}) {
  const r = role();
  if (r === 'student') return myId();
  if (r === 'guardian') return state.me.linked_students?.[0]?.id ?? null;
  return params.id ?? null;
}
