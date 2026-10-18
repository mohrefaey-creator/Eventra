// Hash router with role guards, race-safe rendering, focus management and uniform error states.
import { h, mount } from './html.js';
import { t } from './i18n.js';
import { state, role } from './state.js';
import { ApiError } from './api.js';
import { announce, focusMain } from './a11y.js';
import { renderShell, homeRoute } from './components/shell.js';
import { spinner } from './components/ui.js';
import { refreshMe } from './session.js';

const S = ['student'];
const ROUTES = [
  ['/login', () => import('./views/login.js'), null],
  ['/discover', () => import('./views/landing.js'), S],
  ['/consent', () => import('./views/consent.js'), S],
  ['/dashboard', () => import('./views/dashboard.js'), S],
  ['/evidence', () => import('./views/evidence.js'), S],
  ['/run/:sid', () => import('./views/runner.js'), S],
  ['/results', () => import('./views/results.js'), S],
  ['/majors', () => import('./views/majors.js'), S],
  ['/compare', () => import('./views/compare.js'), S],
  ['/program/:pid', () => import('./views/program.js'), S],
  ['/roadmap', () => import('./views/roadmap.js'), S],
  ['/report', () => import('./views/reports.js'), S],
  ['/report/:rid', () => import('./views/report.js'), ['student', 'guardian', 'counselor']],
  ['/help', () => import('./views/help.js'), S],
  ['/settings', () => import('./views/settings.js'), S],
  ['/guardian', () => import('./views/guardian.js'), ['guardian']],
  ['/counselor', () => import('./views/counselorQueue.js'), ['counselor']],
  ['/counselor/student/:id', () => import('./views/case360.js'), ['counselor']],
  ['/counselor/away/:id', () => import('./views/counselorAway.js'), ['counselor']],
  ['/admin/instruments', () => import('./views/adminInstruments.js'), ['psychometric_lead', 'platform_security']],
  ['/admin/catalog', () => import('./views/adminCatalog.js'), ['catalog_steward', 'psychometric_lead', 'platform_security']],
  ['/admin/control', () => import('./views/control.js'), ['tenant_admin', 'platform_security']],
  ['/admin/assignments', () => import('./views/adminAssignments.js'), ['tenant_admin']],
].map(([pattern, loader, roles]) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:([a-z]+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  return { pattern, loader, roles, re, keys };
});

export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs)) };
}

export const go = (path) => {
  if (location.hash === `#${path}`) render();
  else location.hash = `#${path}`;
};

let seq = 0;
let started = false; // no rendering (or redirecting) before the session is known

function errorView(err) {
  if (err instanceof ApiError) {
    if (err.status === 403) return h`<div class="card bad" role="alert"><h1>${t('err.denied.title')}</h1><p>${t(`deny.${err.reason}`) === `deny.${err.reason}` ? t('err.denied.body') : t(`deny.${err.reason}`)}</p><p class="small muted">${t('err.code')}: <code>${err.reason ?? err.code}</code></p></div>`;
    if (err.status === 503) return h`<div class="card bad" role="alert"><h1>${t('err.suspended.title')}</h1><p>${t('err.suspended.body')}</p></div>`;
    if (err.status === 404) return h`<div class="card"><h1>${t('err.notfound.title')}</h1><p>${t('err.notfound.body')}</p></div>`;
    if (err.status === 0) return h`<div class="card warn" role="alert"><h1>${t('err.offline.title')}</h1><p>${t('err.offline.body')}</p></div>`;
    return h`<div class="card bad" role="alert"><h1>${t('err.generic.title')}</h1><p>${err.message}</p><p class="small muted">${t('err.request_id')}: <code>${err.problem.request_id ?? '—'}</code></p></div>`;
  }
  return h`<div class="card bad" role="alert"><h1>${t('err.generic.title')}</h1><p class="small">${String(err?.message ?? err)}</p></div>`;
}

export async function render() {
  if (!started) return;
  window.onbeforeunload = null; // the runner re-arms this only while it has unsaved answers
  const my = ++seq;
  const { path, query } = parseHash();
  const app = document.getElementById('app');
  const authed = Boolean(state.me?.authenticated);
  if (!authed && path !== '/login') return go('/login');
  if (authed && (path === '/' || path === '/login')) return go(homeRoute(role()));

  renderShell(path);
  app.removeAttribute('data-route');
  const match = ROUTES.map((r) => ({ r, m: r.re.exec(path) })).find((x) => x.m);
  if (!match) {
    mount(app, errorView(new ApiError(404, {})));
    app.dataset.route = path;
    return;
  }
  const { r, m } = match;
  if (r.roles && !r.roles.includes(role())) {
    mount(app, errorView(new ApiError(403, { reason: 'role_not_permitted' })));
    app.dataset.route = path;
    return;
  }
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  mount(app, spinner());
  try {
    const mod = await r.loader();
    const view = await mod.default({ params, query, path });
    if (my !== seq) return; // a newer navigation superseded this one
    document.title = `${view.title} — ${t('app.name')}`;
    mount(app, view.body);
    view.after?.(app);
    app.dataset.route = path;
    focusMain();
    announce(view.title);
  } catch (e) {
    if (my !== seq) return;
    if (e instanceof ApiError && e.status === 401) {
      state.me = null;
      return go('/login');
    }
    if (e instanceof ApiError && e.status === 503) {
      await refreshMe().catch(() => {}); // pick up incident mode so the banner shows
      renderShell(path);
    }
    mount(app, errorView(e));
    app.dataset.route = path;
    focusMain();
    if (!(e instanceof ApiError)) console.error(e);
  }
}

export function startRouter() {
  started = true;
  window.addEventListener('hashchange', render);
  return render();
}
