// Auto-escaping template tag. Every interpolated value is escaped unless it is already Safe.
// Together with the CSP (no inline script/style) this closes the XSS paths for server-provided text.
export class Safe {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = (v) => String(v).replace(/[&<>"'`]/g, (c) => ESC[c]);

export function toHtml(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(toHtml).join('');
  return esc(v);
}

export function h(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += toHtml(vals[i]) + strings[i + 1];
  return new Safe(out);
}

export const raw = (s) => new Safe(String(s));
/** Accepts a Safe fragment, an array of fragments, or plain text (escaped). */
export const mount = (el, v) => {
  el.innerHTML = toHtml(v);
};

/** Isolates mixed-direction text (English names inside Arabic sentences, ids, hashes). */
export const bdi = (text) => h`<bdi>${text}</bdi>`;
export const ltr = (text) => h`<code class="ltr" dir="ltr">${text}</code>`;
