// NextMind Student Discovery — local synthetic-data prototype.
import fs from 'node:fs';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

if (process.argv.includes('--reset-only')) {
  if (config.dataFile && fs.existsSync(config.dataFile)) fs.rmSync(config.dataFile);
  console.log('Local prototype database removed. It is re-seeded with synthetic data on next start.');
  process.exit(0);
}

const { server } = createApp();
server.listen(config.port, config.host, () => {
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log(`\nNextMind Student Discovery — SYNTHETIC PROTOTYPE\n  ${url}\n`);
  console.log('Synthetic personas and fictional programs only. No real student data. Not a production system.');
  if (config.host === '0.0.0.0') console.warn('WARNING: listening on all interfaces. Keep this local; the prototype has no real authentication.');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
