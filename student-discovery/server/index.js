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

const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
if (!loopback && !config.allowAnyHost) {
  console.error(`Refusing to listen on ${config.host}: the persona sign-in is not real authentication.\nUse HOST=127.0.0.1, or set ALLOW_NETWORK_HOST=true if you accept that anyone on the network can act as any persona.`);
  process.exit(1);
}

const { server } = createApp();
server.listen(config.port, config.host, () => {
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log(`\nNextMind Student Discovery — SYNTHETIC PROTOTYPE\n  ${url}\n`);
  console.log('Synthetic personas and fictional programs only. No real student data. Not a production system.');
  if (!loopback) console.warn('WARNING: ALLOW_NETWORK_HOST is on. Anyone who can reach this port can act as any persona.');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
