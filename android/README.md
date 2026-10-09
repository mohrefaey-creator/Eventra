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
| **Verified here** | The pairing logic (`core/`, 24 tests, 9 of them running the real Node server). The app's Kotlin type-checks against the real Android 16 framework and WebRTC 150. Every resource the manifest and code reference exists. |
| **Not verified** | Building the APK with the Android Gradle Plugin, installing it, screen capture, video on a real device, Android App Links verification, behaviour on Android 14 to 16 foreground-service rules, Honor and Samsung specifics. The first run on a real device is the real test. |

The cloud environment this was written in cannot reach the Android SDK or Google's Maven repository,
so a real build was not possible there. Expect to fix small things on the first build.

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
```
