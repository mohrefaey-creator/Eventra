// Vercel adapter: runs the same request handler as `npm start`, one app per warm function instance.
//
// Read this before deploying:
//  * State lives in memory and is seeded with synthetic data when an instance starts. Vercel may start, stop or
//    add instances at any time, so data and sign-ins can disappear and two instances can disagree. This is a demo
//    host for looking at the prototype, not a place to keep anything.
//  * The persona sign-in is NOT authentication. `allowAnyHost` only lifts the loopback-only Host check, so the
//    deployment MUST stay behind Vercel Deployment Protection (Vercel Authentication or a password).
//  * There is no Chromium on Vercel, so "Download PDF" answers 501 and the screen falls back to print.
import { createApp } from '../server/app.js';

const app = createApp({ dataFile: null, allowAnyHost: true });

export default function handler(req, res) {
  return app.handler(req, res);
}
