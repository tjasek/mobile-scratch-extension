# Mobile Events Extension

A JavaScript extension for **Cocrea / Gandi IDE / TurboWarp** that brings
AppInventor-style mobile capabilities to Scratch projects and **builds a mobile
app directly from the extension** — standalone HTML, a Cordova project, an App
Inventor `.aia`, or a cloud-built APK.

The extension is compatible with both the Gandi/Cocrea extension runtime and
vanilla TurboWarp.

The first time you use any mobile block, the extension asks whether the app
should be **portrait** or **landscape**, then resizes the editor stage to a
phone-shaped viewport so you can preview the app's proportions while you build.

## Loading the extension

1. Serve `mobile-extension.js` at a URL (for local dev, the VSCode *Live Server*
   extension works well).
2. In the Cocrea/Gandi editor, open the **Extensions** tab → **Custom** and load
   the extension by its URL.
3. The **Mobile Events** category appears in the block palette.

## Blocks

### Build Mobile App
These blocks build the app **directly from the extension**. See
[Building a mobile app](#building-a-mobile-app) for the full flow.

**Outputs**

| Block | Type | Description |
| --- | --- | --- |
| 📱 Download standalone app (HTML) | button | A single self-contained `.html` that runs your project offline (also works inside a mobile WebView). |
| 🤖 Download Android project (Cordova) | button | A ready-to-compile Cordova project (`.zip`) → installable APK/IPA with one CLI command. |
| 🧩 Download App Inventor project (.aia) | button | An App Inventor project that shows your app in a full-screen WebViewer; import it into MIT App Inventor and build an APK there. |
| ☁️ Build APK in the cloud | button | Uploads the Cordova project to a configured cloud build service and downloads the finished APK — no local tooling. |
| build standalone app (HTML) | command | Script version of the HTML button. |
| build Android project (Cordova) | command | Script version of the Cordova button. |
| build status | reporter | `idle` / `building` / `uploading` / `done` / `error: …`. |

**App info**

| Block | Type | Description |
| --- | --- | --- |
| set app name to [NAME] | command | The app's display name. |
| set app package id to [ID] | command | Reverse-domain id, e.g. `world.cocrea.myapp`. |
| lock app orientation to [any/portrait/landscape] | command | Locks the native app orientation. |
| preview app as [portrait/landscape] in editor | command | Resizes the editor stage to a phone viewport to preview proportions. |

**Build settings** (mirror the TurboWarp packager)

| Block | Type | Description |
| --- | --- | --- |
| [setting] [on/off] | command | Toggle: **start with green flag** (autostart), **turbo mode**, **frame interpolation**, **high quality pen**, **keep sprites on stage (fencing)**, **runtime limits**, **fullscreen**. |
| set app framerate to [FPS] fps | command | 30 or 60 (or any 1–240). |
| set app resize mode to [MODE] | command | `preserve ratio`, `stretch`, or `resize (dynamic)`. |
| set app clone limit to [LIMIT] | command | Max clones (0 or less = unlimited). |
| set app username to [NAME] | command | Value returned by the `username` block. |
| set cloud build service to [URL] | command | Endpoint used by *Build APK in the cloud*. |

### Touch
| Block | Type | Description |
| --- | --- | --- |
| when screen touched | event | Fires on touch/press start. |
| when touch moves | event | Fires while a touch is dragged. |
| when touch released | event | Fires when the touch/press ends. |
| is screen being touched? | boolean | True while a touch is active. |
| touch x / touch y | reporter | Touch position in Scratch stage coordinates (-240..240, -180..180). |
| number of touches | reporter | Count of active touch points (multi-touch). |

### Scroll & Swipe
| Block | Type | Description |
| --- | --- | --- |
| when scrolled [direction] | event | Fires on wheel scroll or touch swipe. `any` matches every direction. |
| last scroll direction | reporter | `up` / `down` / `left` / `right`. |
| scroll delta [x/y] | reporter | Distance of the last scroll/swipe on the chosen axis. |

### Orientation
| Block | Type | Description |
| --- | --- | --- |
| when rotated to portrait | event | Fires when the screen becomes portrait. |
| when rotated to landscape | event | Fires when the screen becomes landscape. |
| when orientation changes | event | Fires on any portrait↔landscape change. |
| screen is [portrait/landscape]? | boolean | Current orientation check. |
| screen orientation | reporter | `portrait` or `landscape`. |

### Device Sensors
| Block | Type | Description |
| --- | --- | --- |
| enable motion sensors | command | Requests motion/orientation permission (required on iOS 13+; must be triggered by a user action). |
| when device tilts | event | Fires on device-orientation updates. |
| when device shaken | event | Fires when a shake gesture is detected. |
| device [azimuth/pitch/roll] | reporter | Compass heading, front-back tilt, and left-right tilt in degrees, mirroring AppInventor's `OrientationSensor`. |
| acceleration [x/y/z] | reporter | Device acceleration per axis, mirroring AppInventor's `AccelerometerSensor`. |

## Notes on mobile sensors

- **iOS 13+** requires an explicit user gesture before motion and orientation
  events are delivered. Call **enable motion sensors** from a block that runs in
  response to a tap (e.g. inside `when screen touched`).
- Touch coordinates are converted from screen pixels into Scratch stage
  coordinates so they line up with sprite positions.
- Swipe detection uses a 30px minimum movement threshold to avoid firing on
  small taps.

## Building a mobile app

The extension builds the app itself, inside the browser. Two outputs are
available.

### How it works

A Scratch project runs in a browser, so the extension produces a **web-based
app** — the same core artifact the TurboWarp packager makes. At build time it:

1. Serializes the currently open project to `.sb3` straight from the VM.
2. Fetches the TurboWarp *scaffolding* runtime (a minimal Scratch player) once
   and **inlines** it.
3. Emits a single HTML file with the runtime + project (base64) + a green-flag
   launcher, so it runs fully offline.

All build settings above (green-flag autostart, framerate, turbo, interpolation,
high quality pen, fencing, runtime limits, resize mode, clone limit, username)
are baked into the generated app, matching the TurboWarp packager's options.

> A browser sandbox can't invoke the Android SDK or Xcode, so the extension
> can't compile a native `.apk`/`.ipa` locally. It gets you there via a Cordova
> project, an App Inventor project, or a cloud build service.

### Option 1 — Standalone HTML app

Click **📱 Download standalone app (HTML)**. You get one `.html` file that runs
offline on any device or inside any WebView. Quickest way to test on a phone.

### Option 2 — Native Android/iOS app (Cordova)

Click **🤖 Download Android project (Cordova)**. You get a `.zip` containing:

```
www/index.html   ← your app, bundled offline
config.xml       ← app name, id, orientation
package.json
README.txt       ← build steps
```

Then, with [Cordova](https://cordova.apache.org/) installed:

```bash
unzip my-mobile-app-cordova.zip -d my-app && cd my-app
cordova platform add android
cordova build android          # → installable APK
```

For iOS (macOS + Xcode): `cordova platform add ios && cordova build ios`.

### Option 3 — MIT App Inventor (.aia)

Click **🧩 Download App Inventor project (.aia)**. App Inventor can't import a
Scratch project, so the `.aia` gives you an App Inventor app whose `Screen1` is
a full-screen **WebViewer** that displays your packaged app (included in the
archive as `assets/app.html`). Steps (also in the archive's `README.txt`):

1. At [ai2.appinventor.mit.edu](https://ai2.appinventor.mit.edu): **Projects →
   Import project (.aia)**.
2. Host `assets/app.html` somewhere reachable by the phone (any static host).
3. Select **AppWebViewer** in the Designer and set its **HomeUrl** to that URL.
4. **Build → App (.apk / .aab)**.

Android's WebViewer needs a real URL, so hosting the one HTML file is the
reliable approach.

### Option 4 — Cloud APK (no local tooling)

Click **☁️ Build APK in the cloud**. This uploads the Cordova project to a build
service and downloads the finished APK. You must first point it at a
Cordova-compatible endpoint:

- Block: **set cloud build service to [URL]**, or
- Global: `window.MOBILE_BUILD_SERVICE_URL = 'https://your-endpoint/'`.

Expected endpoint contract:

- `POST <url>` with multipart field `project` = the project zip. Returns either
  the APK binary directly, or JSON `{ id }` (async) / `{ downloadUrl }`.
- `GET <url>status/<id>` → JSON `{ status: 'pending'|'done'|'error', downloadUrl?, message? }`.

There is no universal free public build endpoint, so this is left unconfigured
by default. Any Cordova/PhoneGap-Build/VoltBuilder-style service that follows the
contract above works; a small self-hosted wrapper around the Cordova CLI works too.

### Configuring the build

Set these before building (in a script, or drag onto the stage and click):

- **set app name**, **set app package id**, **lock app orientation**.
- Build-setting toggles + **set app framerate / resize mode / clone limit /
  username** (see the block tables above).

### Orientation preview

The first mobile block you use prompts for portrait vs landscape and resizes the
editor stage (`360×640` portrait / `640×360` landscape) so you can preview the
app's shape. You can re-trigger this any time with **preview app as [mode] in
editor**, and it also sets the app's locked orientation.

### Overriding sources (for forks / offline networks)

Set these globals before the extension loads:

- `window.MOBILE_SCAFFOLDING_URL` — alternate scaffolding runtime URL.
- `window.MOBILE_JSZIP_URL` — alternate JSZip URL.
- `window.MOBILE_BUILD_SERVICE_URL` — default cloud build endpoint.

## License

LGPL-3.0-only, matching the surrounding extension repository.
