# MirrorLink for iPhone and iPad

The iOS sender. It shows your screen on the MirrorLink receiver (the web page a laptop opens), over the same
protocol as the Android app, so one receiver page serves both. Personal use: no App Store, no account other
than an Apple ID.

**What a person does:** open the app, type the 6-digit code from the receiving screen (or scan its QR with the
camera, which opens the app with the code filled in), tap **Start mirroring**, then tap **Start Broadcast** on
Apple's own sheet, then tap **Allow** on the receiver. Stop from Control Center (the red record button) or
by opening the sheet again.

## Status: read this first

| | |
|---|---|
| **Verified** | The pairing core (`MirrorLinkCore/`: links, protocol, session state machine, shared settings) has 31 tests that pass, 10 of them driving a real session against this repository's Node server. XcodeGen accepts `project.yml` and produces an app that embeds the broadcast extension. |
| **Not verified** | Everything that needs Apple's SDK and a device: the screen (`App/`), the broadcast extension (`Broadcast/`), the WebRTC video, the cloud build below, signing and installing. None of the UIKit, ReplayKit or WebRTC code has been compiled yet, so expect a few compile errors on the first cloud build and a few surprises on the first real run, as the Android app had. |

Known risks, so they are not a surprise:

- **Memory.** iOS lets a broadcast extension use about 50 MB. The video is downscaled and H.264 (hardware) is
  preferred to stay under it. If iOS kills the broadcast on a large iPad, pick **Low bandwidth** in the app.
- **App Group.** The app and its extension pass the code through an App Group (`group.<bundle id>`). It works
  with a normal Apple ID in Xcode. With a re-signing tool it depends on the tool preserving the group.
- **Rotation** of the picture when you turn the device is untested.

## Getting the app onto your device

You need: an Apple ID, and the iPhone/iPad. Install is **free**, with one catch: apps signed with a free Apple ID
stop opening after **7 days** and have to be installed again (Sideloadly can refresh them). A paid Apple
Developer account ($99/year) makes it last a year.

### 1. Get the .ipa (no Mac needed)

The workflow `.github/workflows/ios.yml` builds it on a Mac in GitHub's cloud:

1. Put this repository on GitHub (the `ios/` folder and `.github/` are what matter).
2. Open the **Actions** tab, pick **iOS app**, run it (or push a change under `ios/`).
3. When it finishes, open the run and download **MirrorLink-unsigned-ipa** (a zip with `MirrorLink.ipa`).

The .ipa is unsigned on purpose: you sign it yourself in step 2, so nothing secret is stored in GitHub.
(For a private repository GitHub's free allowance is small for Mac builds; a build takes about 10 minutes.)

### 2a. Install from a Windows laptop (Sideloadly)

1. Install **iTunes** and **iCloud** from apple.com (the Microsoft Store versions do not work), and
   **Sideloadly** from sideloadly.io.
2. Connect the iPhone/iPad with a cable, unlock it and tap **Trust**.
3. Drag `MirrorLink.ipa` into Sideloadly, type your Apple ID, press **Start**.
4. On the device: **Settings → General → VPN & Device Management →** your Apple ID **→ Trust**.
5. On iOS 16 and later, also turn on **Settings → Privacy & Security → Developer Mode** and restart.

### 2b. Install from a Mac (Xcode)

```bash
brew install xcodegen
cd ios && xcodegen          # creates MirrorLink.xcodeproj
open MirrorLink.xcodeproj
```

In Xcode, for **both** targets (MirrorLink and MirrorLinkBroadcast) choose your Apple ID under *Signing &
Capabilities*, plug in the device, press Run. If Xcode says the bundle identifier is taken, change
`MIRRORLINK_BUNDLE_ID` in `project.yml` (it is used for the app, the extension and the App Group) and run
`xcodegen` again.

## Using it

The server address is built into the app when it is made (workflow input *server*, or `MIRRORLINK_SERVER` in
`project.yml`) and can be changed in the app with **Change**. It accepts plain `http://` addresses on your
home network as well as `https://`.

The first time the app opens, iOS asks to allow **local network** access. Say yes: it lets the iPhone reach
your laptop directly instead of going around through the internet.

## Layout

```
MirrorLinkCore/   Swift package, no Apple-only code: runs and is tested on Linux too
                    cd MirrorLinkCore && swift test       (needs node on the PATH)
App/              the screen with the code box and Start button
Broadcast/        the broadcast extension: ReplayKit frames in, WebRTC video out
Shared/           the little bit both of them use
project.yml       XcodeGen description of the two targets
scripts/          make_icon.py redraws the app icon
```
