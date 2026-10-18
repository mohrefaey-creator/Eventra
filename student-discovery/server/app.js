// Application factory: wires store, router, sessions and the HTTP server. Used by index.js and tests.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createRouter, createSessions, createHandler } from './http.js';
import { registerRoutes } from './routes.js';
import { seedDatabase } from './seed.js';
import { loadConfig, POLICY } from './config.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');

/**
 * @param opts.dataFile   path to the JSON database, or null for in-memory (tests)
 * @param opts.clock      () => Date, injectable for tests
 * @param opts.seed       seed synthetic data when the database is empty (default true)
 */
export function createApp(opts = {}) {
  const config = { ...loadConfig(), rateLimitPerMinute: POLICY.rate_limit_per_minute, loginLimitPerMinute: POLICY.login_limit_per_minute, ...opts };
  const clock = opts.clock ?? (() => new Date());
  const store = createStore({ file: config.dataFile });
  if (opts.seed !== false && !store.db.meta.seeded_at) seedDatabase(store, clock());
  const router = createRouter();
  const sessions = createSessions({ clock });
  registerRoutes(router, { sessions, clock });
  const handler = createHandler({ store, config, router, sessions, clock, webRoot });
  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      console.error('unhandled', e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  return { server, store, config, clock };
}
