// Sign-in state for the synthetic identity stand-in. Kept separate from main.js so views can import it.
import { api, get, setCsrf, IDENT, BASE } from './api.js';
import { state, role, myId } from './state.js';
import { applyAccessibilityPrefs } from './a11y.js';

export async function refreshMe() {
  const { data } = await api('GET', `${IDENT}/me`);
  state.me = data;
  setCsrf(data.csrf_token);
  return data;
}

/** Accessibility preferences follow the student across devices (stored server-side). */
export async function loadStudentPrefs() {
  if (role() !== 'student') return applyAccessibilityPrefs(null);
  try {
    const p = await get(`${BASE}/students/${myId()}/discovery-profile`);
    applyAccessibilityPrefs(p.preferences.accessibility);
  } catch {
    applyAccessibilityPrefs(null);
  }
}

export async function signIn(personaId) {
  await api('POST', `${IDENT}/login`, { persona_id: personaId });
  await refreshMe();
  await loadStudentPrefs();
}

export async function signOut() {
  await api('POST', `${IDENT}/logout`, {});
  state.me = null;
  setCsrf(null);
  applyAccessibilityPrefs(null);
}
