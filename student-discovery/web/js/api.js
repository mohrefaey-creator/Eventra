// Thin fetch wrapper: JSON in/out, CSRF header, RFC 7807 problems surfaced as ApiError.
export const BASE = '/api/v1/discovery';
export const IDENT = '/api/v1/identity-stub';

export class ApiError extends Error {
  constructor(status, problem) {
    super(problem?.detail || problem?.title || `HTTP ${status}`);
    this.status = status;
    this.problem = problem ?? {};
    this.code = problem?.code ?? null;
    this.reason = problem?.reason ?? null;
  }
}

let csrf = null;
export const setCsrf = (v) => (csrf = v);

export async function api(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (method !== 'GET' && csrf) init.headers['X-CSRF-Token'] = csrf;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    const err = new ApiError(0, { code: 'network', detail: 'Network unavailable' });
    err.cause = e;
    throw err;
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return { data, headers: res.headers, status: res.status };
}

/** Binary download (PDF). Problems come back as the same ApiError as everywhere else. */
export async function download(path) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin' });
  } catch (e) {
    const err = new ApiError(0, { code: 'network', detail: 'Network unavailable' });
    err.cause = e;
    throw err;
  }
  if (!res.ok) {
    let data = null;
    try {
      data = JSON.parse(await res.text());
    } catch {
      /* not a problem document */
    }
    throw new ApiError(res.status, data);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'report.pdf';
  return { blob: await res.blob(), name };
}

export const get = async (p) => (await api('GET', p)).data;
export const post = async (p, b = {}) => (await api('POST', p, b)).data;
export const put = async (p, b = {}, h) => api('PUT', p, b, h);
export const patch = async (p, b = {}) => (await api('PATCH', p, b)).data;
export const del = async (p) => (await api('DELETE', p)).data;
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
