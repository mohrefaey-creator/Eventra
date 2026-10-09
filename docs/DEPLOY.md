# Hosting MirrorLink

The Android app (and anyone away from your office Wi-Fi) needs MirrorLink at a normal HTTPS address such as
`https://mirror.example.com`. This is the shortest path: one small server running Docker.

**Status:** the server code, its tests and the compose file's syntax are checked. The Docker image itself was
not built where this was written (no Docker daemon was available), so run the first deploy and the checks below
yourself before relying on it.

## What you need

- A small Linux server with Docker and Docker Compose. A basic VPS is enough: the server only passes small
  pairing messages; video goes straight between devices (or through the TURN relay below).
- A domain name whose DNS `A` record points at the server's public IP.
- Open ports: `80` and `443` (web). For the optional TURN relay also `3478` (UDP and TCP) and `49160-49300` (UDP).

## Deploy

```bash
git clone <your repo> && cd <repo>/deploy
cp .env.example .env        # then edit: at least DOMAIN
docker compose up -d        # app + automatic HTTPS (Caddy)
```

Open `https://<your domain>/receive` on a laptop: you should see a pairing code and a QR whose address is your
domain. The first load can take a few seconds while Caddy obtains the certificate.

`curl https://<your domain>/healthz` should answer `ok`.

### Add the TURN relay (recommended)

Most home and office networks let two devices connect directly. Guest Wi-Fi, mobile data and strict firewalls do
not, and then mirroring fails without a relay. In `.env` set:

```
TURN_SECRET=<output of: openssl rand -hex 32>
TURN_URLS=turn:mirror.example.com:3478,turn:mirror.example.com:3478?transport=tcp
PUBLIC_IP=<the server's public IP>
```

then `docker compose --profile turn up -d`. The app hands every client a fresh, short-lived TURN credential derived
from `TURN_SECRET` (valid one hour by default, `TURN_TTL` seconds to change it), so the relay cannot be used by
someone who merely copied an old credential. The bundled relay refuses to forward to private network ranges and
caps per-user and total allocations.

To check it works, use a Trickle ICE tester with a relay entry from `https://<your domain>/api/info`; you should
see `relay` candidates appear.

### Use your own Android app link

Set `ANDROID_APP_URL` (where people download the app) and `ANDROID_CERT_SHA256` (the fingerprint of the key the
APK is signed with) in `.env`, then `docker compose up -d` again. See [`android/README.md`](../android/README.md).

## Running it without Docker

```bash
npm ci --omit=dev
PORT=3000 TLS=off PUBLIC_URL=https://mirror.example.com TRUST_PROXY=1 node server/index.js
```

behind any reverse proxy that terminates HTTPS and forwards WebSockets on `/ws`. The environment variables are
listed in the main README.

## Operating it

- **Stateless.** Pairing codes and sessions live in memory; restarting the server ends any active session and nothing
  else. There is nothing to back up.
- **Updates.** `git pull && docker compose up -d --build`.
- **Logs.** `docker compose logs -f mirrorlink`.
- **Scale.** One small server handles many simultaneous pairings; it is not built for horizontal scaling (rooms are
  per-process).

## Security notes

- Every connection needs the receiver's explicit approval, so a guessed code alone never shows anything. Wrong guesses
  are rate-limited per IP, which is why `TRUST_PROXY=1` matters behind Caddy: without it every user looks like the proxy.
  Only set it when the proxy in front is yours.
- Do not expose the app container's port 3000 directly to the internet when `TRUST_PROXY=1` (anyone could forge
  `X-Forwarded-For`). The compose file only publishes Caddy's ports.
- There are no accounts, logins or stored data; the server never sees the video.
