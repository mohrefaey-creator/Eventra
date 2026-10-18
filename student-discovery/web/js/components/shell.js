import { h, mount } from '../html.js';
import { t, getLocale } from '../i18n.js';
import { state } from '../state.js';
import { L } from './ui.js';

const NAV = {
  student: [['discover', 'nav.home'], ['dashboard', 'nav.dashboard'], ['results', 'nav.results'], ['majors', 'nav.majors'], ['roadmap', 'nav.roadmap'], ['report', 'nav.report'], ['help', 'nav.help'], ['settings', 'nav.settings']],
  guardian: [['guardian', 'nav.guardian']],
  counselor: [['counselor', 'nav.queue']],
  psychometric_lead: [['admin/instruments', 'nav.instruments'], ['admin/catalog', 'nav.catalog']],
  catalog_steward: [['admin/catalog', 'nav.catalog']],
  tenant_admin: [['admin/control', 'nav.control'], ['admin/assignments', 'nav.assignments']],
  platform_security: [['admin/control', 'nav.control'], ['admin/instruments', 'nav.instruments'], ['admin/catalog', 'nav.catalog']],
};

export function homeRoute(r) {
  return { student: '/discover', guardian: '/guardian', counselor: '/counselor', psychometric_lead: '/admin/instruments', catalog_steward: '/admin/catalog', tenant_admin: '/admin/control', platform_security: '/admin/control' }[r] ?? '/login';
}

const LOGO = h`<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="7" fill="#0b5c8a"/><path d="M8 22l5-12 4 8 3-5 4 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function renderShell(currentPath) {
  const me = state.me?.persona;
  const links = me ? (NAV[me.role] ?? []) : [];
  const other = getLocale() === 'ar-SA' ? 'en' : 'ar-SA';
  const inc = state.me?.incident_mode;
  const top = h`
    ${inc?.enabled ? h`<div class="incident-banner" role="alert">⚠ ${t('incident.banner')}${inc.reason ? h` — ${inc.reason}` : ''}</div>` : ''}
    <div class="proto-banner" role="note"><strong>${t('proto.banner.title')}</strong> ${t('proto.banner.body')}</div>
    <header class="site-header">
      <div class="inner">
        <a class="brand" href="#${me ? homeRoute(me.role) : '/login'}">${LOGO}<span>${t('app.name')}</span></a>
        <nav class="nav" aria-label="${t('nav.main')}">
          ${links.map(([path, key]) => h`<a href="#/${path}" ${currentPath === `/${path}` || currentPath.startsWith(`/${path}/`) ? h`aria-current="page"` : ''}>${t(key)}</a>`)}
        </nav>
        <div class="row">
          <button class="btn secondary small" type="button" data-action="toggle-locale" lang="${other}">${t('lang.switch')}</button>
          ${me ? h`<span class="small muted"><bdi>${L(me.display_name)}</bdi> · ${t(`role.${me.role}`)}</span>
            <button class="btn secondary small" type="button" data-action="logout">${t('auth.logout')}</button>` : ''}
        </div>
      </div>
    </header>`;
  mount(document.getElementById('shell-top'), top);
  mount(document.getElementById('shell-footer'), h`<p>${t('footer.limits')}</p><p>${t('footer.policy', { v: state.me?.policy?.policy_version ?? '—' })}</p>`);
  const skip = document.getElementById('skip-link');
  if (skip) skip.textContent = t('a11y.skip');
}
