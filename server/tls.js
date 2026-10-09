// Self-signed certificate for LAN use. Browsers only expose screen capture on
// secure origins, and http://192.168.x.x is not one - https:// with a
// self-signed cert (accepted once per device) is.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from 'selfsigned';

const CERT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.certs');

/** Returns { key, cert }, reusing the cached pair while its SAN list still matches. */
export async function loadOrCreateCert(ipAddresses) {
  const names = ['localhost', ...ipAddresses].sort();
  const keyPath = join(CERT_DIR, 'key.pem');
  const certPath = join(CERT_DIR, 'cert.pem');
  const metaPath = join(CERT_DIR, 'meta.json');

  if (existsSync(keyPath) && existsSync(certPath) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.names?.join() === names.join() && meta.expires > Date.now() + 7 * 86_400_000) {
        return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
      }
    } catch {
      // fall through and regenerate
    }
  }

  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + 365 * 86_400_000);
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
    ...ipAddresses.map((ip) => ({ type: 7, ip })),
  ];
  const pems = await generate([{ name: 'commonName', value: 'MirrorLink local server' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  writeFileSync(certPath, pems.cert);
  writeFileSync(metaPath, JSON.stringify({ names, expires: notAfterDate.getTime() }));
  return { key: pems.private, cert: pems.cert };
}
