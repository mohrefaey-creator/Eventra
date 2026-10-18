import { h } from '../html.js';
import { get, put, BASE } from '../api.js';
import { t, getLocale, setLocale } from '../i18n.js';
import { myId } from '../state.js';
import { applyAccessibilityPrefs, announce } from '../a11y.js';

export default async function view() {
  const sid = myId();
  const p = (await get(`${BASE}/students/${sid}/discovery-profile`)).preferences.accessibility;
  return {
    title: t('settings.title'),
    body: h`<div class="stack"><h1>${t('settings.title')}</h1>
      <form id="set-form" class="card stack" novalidate>
        <h2>${t('settings.access.title')}</h2>
        <div class="field"><label for="ts">${t('settings.text_size')}</label>
          <select id="ts" name="text_size">${['normal', 'large', 'xlarge'].map((v) => h`<option value="${v}" ${p.text_size === v ? 'selected' : ''}>${t(`settings.size.${v}`)}</option>`)}</select></div>
        <div class="check"><input type="checkbox" id="hc" name="high_contrast" ${p.high_contrast ? 'checked' : ''}><label for="hc">${t('settings.high_contrast')}</label></div>
        <div class="check"><input type="checkbox" id="rm" name="reduce_motion" ${p.reduce_motion ? 'checked' : ''}><label for="rm">${t('settings.reduce_motion')}</label></div>
        <p class="hint">${t('settings.untimed')}</p>
        <div class="field"><label for="lg">${t('settings.language')}</label>
          <select id="lg" name="locale"><option value="ar-SA" ${getLocale() === 'ar-SA' ? 'selected' : ''}>العربية</option><option value="en" ${getLocale() === 'en' ? 'selected' : ''}>English</option></select></div>
        <p id="set-msg" role="status" class="hint"></p>
        <button class="btn" type="submit">${t('common.save')}</button>
      </form>
      <p><a href="#/consent">${t('settings.manage_consent')}</a></p></div>`,
    after(root) {
      const form = root.querySelector('#set-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const acc = { text_size: form.text_size.value, high_contrast: form.high_contrast.checked, reduce_motion: form.reduce_motion.checked };
        await put(`${BASE}/students/${sid}/preferences`, { accessibility: acc, locale: form.locale.value });
        applyAccessibilityPrefs(acc);
        if (form.locale.value !== getLocale()) setLocale(form.locale.value);
        else {
          root.querySelector('#set-msg').textContent = t('settings.saved');
          announce(t('settings.saved'));
        }
      });
    },
  };
}
