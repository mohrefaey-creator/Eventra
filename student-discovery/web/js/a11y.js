// Announcements and focus management for screen reader and keyboard users.
const polite = () => document.getElementById('live');
const assertive = () => document.getElementById('live-assertive');

export function announce(msg, urgent = false) {
  const el = urgent ? assertive() : polite();
  if (!el) return;
  el.textContent = '';
  // a tick lets assistive tech register the change even when the text repeats
  setTimeout(() => (el.textContent = msg), 30);
}

export function focusMain() {
  const target = document.querySelector('#app h1') || document.getElementById('main');
  if (target) {
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: false });
  }
}

export function applyAccessibilityPrefs(prefs) {
  const root = document.documentElement;
  root.dataset.textSize = prefs?.text_size ?? 'normal';
  root.dataset.contrast = prefs?.high_contrast ? 'high' : 'normal';
  root.dataset.motion = prefs?.reduce_motion ? 'reduce' : 'normal';
}
