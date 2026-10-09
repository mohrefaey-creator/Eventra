# MirrorLink wire protocol

For writing a **native sender** (iOS ReplayKit, Android MediaProjection, desktop app) that pairs with the
existing receiver page. Transport is a WebSocket carrying JSON text frames at `/ws`; video is WebRTC.

- Max message size: 64 KiB. Binary frames are rejected.
- Browsers must connect from the same origin as the server. Native clients send no `Origin` header and are allowed.
- Use `wss://` when the server is behind TLS. Self-signed development certificates must be trusted or pinned by the client.

## Roles

- **Receiver** (host): shows the picture. Creates a pairing code.
- **Sender** (peer): the device being mirrored. Joins with the code and sends the video.

One receiver has at most one sender at a time. A socket holds one role at a time.

## Messages

### Receiver → server

| `type` | Fields | Meaning |
|---|---|---|
| `host` | – | Create a room. Answered with `hosted`. |
| `accept` | `peerId` | Approve the pending sender. |
| `reject` | `peerId` | Decline the pending sender. |
| `end` | – | End the current session; the sender gets `ended`. |
| `refresh` | – | New code (only when no sender is attached). Answered with `hosted`. |
| `signal` | `data` | Relay WebRTC signaling to the sender (after `accept`). |

### Server → receiver

| `type` | Fields | Meaning |
|---|---|---|
| `hosted` | `code`, `ttlMs`, `expiresAt` | Your 6-digit code. |
| `join-request` | `peerId`, `name` | A sender wants to connect. Ask the user. |
| `signal` | `peerId`, `data` | Signaling from the sender. |
| `peer-left` | `peerId` | Sender left, or its request timed out. |
| `code-expired` | – | Unused code expired and the room is gone. Send `host` again. |

### Sender → server

| `type` | Fields | Meaning |
|---|---|---|
| `join` | `code`, `name` | Request pairing. Spaces and dashes in `code` are ignored. `name` ≤ 40 chars. |
| `signal` | `data` | Relay WebRTC signaling to the receiver (after `accepted`). |
| `leave` | – | Stop and disconnect. |

### Server → sender

| `type` | Fields | Meaning |
|---|---|---|
| `waiting` | – | Request delivered; waiting for the user to approve. |
| `accepted` | – | **Start the WebRTC offer now.** |
| `rejected` | `reason` (`denied` \| `timeout`) | Not approved. The socket may `join` again. |
| `signal` | `data` | Signaling from the receiver. |
| `ended` | – | Receiver ended the session. |
| `host-left` | – | Receiver went away. |

### Errors (either direction)

`{ "type": "error", "code": … }` with `code` one of: `bad-code`, `busy`, `rate-limited`, `too-many-rooms`,
`already-registered`, `not-registered`, `not-paired`, `no-such-peer`, `bad-message`.

## WebRTC signaling payloads (`signal.data`)

Same shape in both directions:

```json
{ "description": { "type": "offer" | "answer", "sdp": "…" } }
{ "candidate":   { "candidate": "…", "sdpMid": "0", "sdpMLineIndex": 0 } }
```

The **sender creates the offer** after `accepted`; the receiver answers. There is no renegotiation: one offer/answer,
then trickled ICE candidates both ways. Candidates arrive in order and the offer always precedes the sender's candidates.

ICE servers come from `GET /api/info` → `iceServers` (an `RTCIceServer[]`).

The sender adds a video track (and optionally audio) and offers `sendonly`; the receiver is receive-only.
H.264 and VP8 are both fine; the receiver is a browser.

## Sequence

```
Receiver                    Server                      Sender
   │── host ─────────────────▶│                            │
   │◀──────── hosted(code) ───│                            │
   │          (code shown as digits + QR /send?code=NNNNNN)│
   │                          │◀──── join(code,name) ──────│
   │◀── join-request ─────────│───────── waiting ─────────▶│
   │  user taps Allow         │                            │
   │── accept(peerId) ───────▶│───────── accepted ────────▶│
   │◀── signal(offer) ────────│◀──── signal(offer) ────────│
   │── signal(answer) ───────▶│───── signal(answer) ──────▶│
   │◀═══════ ICE candidates both ways ════════════════════▶│
   │◀═══════════════ WebRTC video (direct) ════════════════│
```

## Links a sender app should understand

The receiver's QR code and the web sender page produce these; parse both (see `PairingLinks` in `android/core`):

```
https://<server>/send?code=123456                          the receiver's QR code
mirrorlink://join?server=https%3A%2F%2F<server>&code=123456  "open in the app" from the web sender page
```

`code` is optional in the second form (the user types it). Fill the form from the link, but let the user tap
Start: never begin sharing from a link alone. An app that wants scanned QR codes to open it directly registers
Android App Links / iOS Universal Links for `https://<server>/send`; the server publishes
`/.well-known/assetlinks.json` when `ANDROID_CERT_SHA256` is set.

## Native sender checklist

- iOS: a Broadcast Upload Extension receives `CMSampleBuffer`s in a separate process; hand frames to the
  app/WebRTC (via App Group) and run signaling there. Extensions have a ~50 MB memory limit, so downscale.
- Android: `MediaProjection` + `VirtualDisplay` → `ScreenCapturerAndroid` in libwebrtc; run it in a foreground
  service with the `mediaProjection` type.
- Show the user *what is being shared* and a one-tap stop, and always require the receiver's approval step above.
