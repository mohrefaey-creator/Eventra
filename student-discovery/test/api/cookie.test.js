// The session cookie is HttpOnly and SameSite=Strict always, and Secure when the request arrived over HTTPS through a proxy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

const login = (headers = {}) =>
  fetch(`${app.origin}/api/v1/identity-stub/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ persona_id: 'user-student-a2' }) });

test('plain-HTTP local use: HttpOnly, SameSite=Strict, not Secure', async () => {
  const cookie = (await login()).headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Secure/);
});

test('behind an HTTPS proxy the cookie is also Secure, on login and logout', async () => {
  const res = await login({ 'x-forwarded-proto': 'https' });
  assert.match(res.headers.get('set-cookie'), /; Secure/);
  const out = await fetch(`${app.origin}/api/v1/identity-stub/logout`, { method: 'POST', headers: { 'x-forwarded-proto': 'https' } });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0; Secure/);
});
