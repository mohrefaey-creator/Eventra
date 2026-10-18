import { loadDictionaries, setLocale, initialLocale, getLocale, onLocaleChange } from './i18n.js';
import { put, BASE } from './api.js';
import { role, myId } from './state.js';
import { render, startRouter, go } from './router.js';
import { refreshMe, loadStudentPrefs, signOut } from './session.js';

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'toggle-locale') {
    const next = getLocale() === 'ar-SA' ? 'en' : 'ar-SA';
    setLocale(next);
    if (role() === 'student') put(`${BASE}/students/${myId()}/preferences`, { locale: next }).catch(() => {});
  } else if (el.dataset.action === 'logout') {
    await signOut();
    go('/login');
  }
});

onLocaleChange(() => render());

async function boot() {
  await loadDictionaries();
  setLocale(initialLocale());
  await refreshMe();
  await loadStudentPrefs();
  await startRouter();
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('app').textContent = 'Failed to start the application. / تعذّر تشغيل التطبيق.';
});
