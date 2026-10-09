# MirrorLink for Android

The sender app for Android phones and tablets (Samsung, Honor and any other Android 8.0+ device). It
captures the screen with MediaProjection and streams it to the MirrorLink web receiver over WebRTC.
It speaks exactly the protocol in [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md), so it pairs with the
same receiver page that laptops open in a browser.

**What a user does:** scan the QR on the receiving screen (the app opens by itself), tap **Start
mirroring**, tap **Start now** on Android's own prompt, then tap **Allow** on the receiver.

No Google Play Services are used, so it also works on Honor and other devices without them.

## Status: read this first

| | |
|---|---|
| **Verified** | A real Gradle build (AGP 8.11, Kotlin 2.2, JDK 17) produces a signed debug APK (21 MB, v0.1.1, arm64-v8a + armeabi-v7a, Android 8.0 to 16). 43 unit tests pass: 25 for the pairing core (9 run the real Node server) and 18 Robolectric tests that drive the real screens and service (form, code formatting, deep links, the notification, capture-consent and service flow, Stop button, failure paths). Android Lint reports no errors. The APK's manifest, permissions and signature were inspected with `aapt2` and `apksigner`. |
| **Not verified** | Anything that needs a physical device: installing, the system screen-capture prompt, actual video reaching the receiver, App Links verification, foreground-service behaviour on Android 14 to 16, Honor and Samsung specifics. Release builds (`assembleRelease`) and the x86 emulator (the build ships ARM libraries only) were not exercised. A first run on a real tablet (Honor NDL-L09) paired and connected, but showed no picture: see "Still screens" below. |

Where the build ran: a Linux microVM with the Android SDK, because the machine this was written on cannot
reach Google's Maven repository. The recipe is the same as the one below; nothing in it is special.

## Build it

You need Android Studio (or the Android SDK command-line tools) and JDK 17+.

1. Edit `gradle.properties`: set `mirrorlinkServer` to your server's address, e.g. `https://mirror.example.com`
   (and `mirrorlinkAppId` if you publish under your own package name).
2. `cd android && ./gradlew :app:assembleDebug`
3. Install `app/build/outputs/apk/debug/app-debug.apk` on a device ("install unknown apps" must be allowed),
   or run it from Android Studio.

Debug builds also allow a plain-HTTP dev server and certificates you installed on the device. Release builds
accept HTTPS with normal certificates only, so **host the server with a real certificate** (see below).

### Release build

```bash
keytool -genkeypair -v -keystore mirrorlink.jks -keyalg RSA -keysize 2048 -validity 10000 -alias mirrorlink
./gradlew :app:assembleRelease \
  -PmirrorlinkKeystore=/path/to/mirrorlink.jks -PmirrorlinkKeystorePassword=… \
  -PmirrorlinkKeyAlias=mirrorlink -PmirrorlinkKeyPassword=…
```

Keep the keystore safe: losing it means you cannot update the app. Google Play wants an app bundle
(`:app:bundleRelease`); sideloading and other app stores take the APK.

## Make the QR open the app directly (Android App Links)

Without this, scanning the QR opens the web page, which has an **Open in the MirrorLink app** button.
Works, but one extra tap. To skip it:

1. Get the SHA-256 fingerprint of the key your APK is signed with: `./gradlew :app:signingReport`
   (or `keytool -list -v -keystore mirrorlink.jks`).
2. Start the server with it: `ANDROID_CERT_SHA256=AA:BB:…` (comma-separate several; add `ANDROID_PACKAGE`
   if you changed the package name). The server then serves `/.well-known/assetlinks.json`.
3. Rebuild with the same `mirrorlinkServer`: the manifest's link host comes from it.

Use the **debug** key's fingerprint while testing debug builds and the **release** key's for release builds.
Also set `ANDROID_APP_URL` on the server so the web page can show a **Get the app** link.

## Hosting

The app needs a server reachable over HTTPS with a certificate Android trusts (a normal domain and Let's
Encrypt, not the self-signed LAN certificate the laptop-only setup uses). See the main README for hosting and
for adding a TURN server, which makes mirroring work between different networks.

## First-run checklist on a real device

- [ ] App installs and opens; the server address shows your domain.
- [ ] Tap Start: Android shows its "start recording or casting" prompt, then the receiver asks to Allow.
- [ ] Video appears on the receiver, sharp enough to read text; rotating the tablet reshapes it.
- [ ] The notification shows while mirroring; its **Stop** button ends the session on both sides.
- [ ] Swiping the app away or turning the screen off behaves sensibly.
- [ ] Scanning the QR with the camera opens the app (after the App Links setup above).
- [ ] Repeat on a Samsung phone, a Samsung tablet and an Honor tablet.

## Not in version 1

Sound (Android needs a separate playback-capture permission and API 29+), scanning a QR from inside the app
(use the phone's camera app), and a Play Store listing.

## Layout

```
core/   Pure Kotlin: link parsing, protocol messages, SenderSession state machine. Runs on any JDK:
        ./gradlew -PcoreOnly :core:test      (needs `node` on the PATH for the integration tests)
app/    The Android app: MainActivity (UI), MirrorService (foreground service), WebRtcPeer (capture + WebRTC)
        ./gradlew :app:testDebugUnitTest    (Robolectric UI/service tests; first run downloads Android jars)
```

## Still screens

Android only delivers a frame when the screen changes. Capture starts before the receiver is connected, so
the one frame a still screen produces is lost, and the receiver stays blank until something moves. Since
v0.1.1 `WebRtcPeer` asks for a fresh frame as soon as the connection is up and again every few seconds
while the screen is still (it re-attaches the capture surface, which libwebrtc 150 does with
`VirtualDisplay.resize`/`setSurface`, so it is safe on Android 14+). The receiver page now also says
"Connected, waiting for the first picture" instead of staying on "Connecting".

## Receiver page: the video must be visible to start

Chrome will not autoplay a video that is hidden. The receiver used to keep the video hidden until it
started playing, so on a real Chrome the picture never appeared even though frames were arriving. The
page now shows the stage and calls `play()` as soon as the video track arrives. `test/e2e.mjs` no longer
launches Chromium with `--autoplay-policy=no-user-gesture-required`, which had been hiding this.
