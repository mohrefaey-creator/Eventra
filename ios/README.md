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
| **Verified** | The pairing core (`MirrorLinkCore/`: links, protocol, session state machine, shared settings) has 31 tests that pass on Linux and on a Mac, 10 of them driving a real session against this repository's Node server. The whole app, including the screen, the broadcast extension and the WebRTC code, compiles for iPhone and iPad with Xcode 16 on GitHub's Mac runners and is packaged into an `.ipa` (see the Actions tab). |
| **Not verified** | Anything that needs a real device: that the extension starts and stays under iOS's memory limit, that video reaches the receiver, rotation, signing with a free Apple ID through Sideloadly, and the App Group working after re-signing. The Android app needed two rounds of fixes on its first real run; expect the same here. |

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

The workflow `.github/workflows/ios.yml` builds it on a Mac in GitHub's cloud, every time something under
`ios/` is pushed:

1. Open the repository's **Actions** tab and pick the latest green run of **iOS app**.
2. At the bottom of the run, download **MirrorLink-unsigned-ipa** (a zip that contains `MirrorLink.ipa`).
3. To bake in a different starting server address, choose **Run workflow** and fill in *server*.

The .ipa is unsigned on purpose: you sign it yourself in step 2, so nothing secret is stored in GitHub.
A build takes about five minutes. The .ipa is about 6 MB, most of it the WebRTC library, which the build checks
is really inside the app (the broadcast extension cannot start without it).

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

## If Start Broadcast does nothing

Re-signing tools change the app's identifiers, so the app finds its own parts at run time instead of trusting
the names in `project.yml` (see `Shared/AppIdentity.swift`). The grey lines at the bottom of the app's screen
say what it found:

- `broadcast part: NOT FOUND` means the extension was not installed with the app.
- `shared storage: NONE` means the signer did not give the app and its extension a common App Group, so the
  code you type cannot reach the extension. Send those lines to whoever is helping you.

A second way in, if the Start button does not open Apple's sheet: after typing the code in the app, open
Control Center, press and hold the grey record button, pick **MirrorLink**, and tap **Start Broadcast**.
