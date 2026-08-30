# Mobile Events Extension

A JavaScript extension for **Cocrea / Gandi IDE / TurboWarp** that brings
AppInventor-style mobile capabilities to Scratch projects and **builds a
standalone HTML app directly from the extension**. To turn that into an
installable APK, open MIT App Inventor and embed the HTML there.

The extension is compatible with both the Gandi/Cocrea extension runtime and
vanilla TurboWarp.

The first time you use any mobile block, the extension asks whether the app
should be **portrait** or **landscape**, then resizes the editor stage to a
phone-shaped viewport so you can preview the app's proportions while you build.

## Loading the extension

In the Cocrea/Gandi editor, open the **Extensions** tab → **Custom** and paste
one of these URLs. The **Mobile Events** category then appears in the palette.

**Pinned release (stable, recommended for sharing):**

```
https://cdn.jsdelivr.net/gh/tjasek/mobile-scratch-extension@v1.2.6/mobile-extension.js
```

**Latest on main (may be cached by jsDelivr for a few hours):**

```
https://cdn.jsdelivr.net/gh/tjasek/mobile-scratch-extension@main/mobile-extension.js
```

**Newest immediately (no CDN cache, good while developing):**

```
https://raw.githubusercontent.com/tjasek/mobile-scratch-extension/main/mobile-extension.js
```

For local development, the VSCode *Live Server* extension serves the file at a
`http://127.0.0.1:5500/...` URL you can load the same way.

## Versioning

The current version is recorded in code as `EXTENSION_VERSION`. Releases are git
tags (`vMAJOR.MINOR.PATCH`) that map to a stable, cache-friendly `@vX.Y.Z`
jsDelivr URL. To use a specific version, swap the tag in the pinned URL above.

## Blocks

### Build Mobile App
These blocks build the app **directly from the extension**. See
[Building a mobile app](#building-a-mobile-app) for the full flow.

**Outputs**

| Button | Description |
| --- | --- |
| 📱 Download standalone app (HTML) | Builds a single self-contained `.html` that runs your project offline (also works inside a mobile WebView). |
| � Open MIT App Inventor | Opens [App Inventor](https://ai2.appinventor.mit.edu) in a new tab so you can embed the HTML and build an APK there. |

| Block | Type | Description |
| --- | --- | --- |
| build standalone app (HTML) | command | Script version of the HTML download button. |

**App info**

| Block | Type | Description |
| --- | --- | --- |
| lock app orientation to [any/portrait/landscape] | command | Locks the app orientation baked into the build. |
| preview app as [portrait/landscape] in editor | command | Resizes the editor stage to a phone viewport to preview proportions. |

**Build settings** (mirror the TurboWarp packager)

These are **buttons** in the palette, not script blocks — clicking one opens a
small dialog so you configure the build through the UI. The values are stored on
the extension and applied to every build.

| Button | Description |
| --- | --- |
| ⚙️ Configure build settings | Toggle on/off options: **start with green flag** (autostart), **turbo mode**, **frame interpolation**, **high quality pen**, **keep sprites on stage (fencing)**, **runtime limits**, **fullscreen**. |
| 🎞 Set framerate (30/60) | 30 or 60 (or any 1–240). |
| 🖼 Set resize mode | `preserve-ratio`, `stretch`, or `dynamic-resize`. |
| 👤 Set username | Value returned by the app's `username` block. |
| 🔢 Set clone limit | Max clones (0 or less = unlimited). |

### Touch
| Block | Type | Description |
| --- | --- | --- |
| when screen touched | event | Fires on touch/press start anywhere on the stage. |
| when touch moves | event | Fires while a touch is dragged. |
| when touch released | event | Fires when the touch/press ends. |
| when this sprite touched | event | Fires only when *this* sprite is the one under the touch (per-sprite, unlike the global "when screen touched"). |
| when this sprite dragged | event | Fires while *this* sprite is being dragged by a touch. |
| is this sprite being touched? | boolean | True while a touch is currently over this sprite. |
| is screen being touched? | boolean | True while any touch is active. |
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
are baked into the generated HTML, matching the TurboWarp packager's options.

### Step 1 — Build the standalone HTML app

Click **📱 Download standalone app (HTML)**. You get one `.html` file that runs
offline on any device or inside a WebView. This is the whole app in a single
file. You can test it right away by opening it on a phone.

### Step 2 — Turn it into an APK with MIT App Inventor

Click **🧩 Open MIT App Inventor** to open
[App Inventor](https://ai2.appinventor.mit.edu). App Inventor can take the HTML
file and embed it (via its WebViewer's HTML content), then build a real APK/AAB
you can install. Follow App Inventor's build flow once your project is set up.

> A browser sandbox can't invoke the Android SDK or Xcode, so the extension
> can't compile a native `.apk` itself. App Inventor handles that final step.

### Configuring the build

Set these before building (in a script, or drag onto the stage and click):

- **lock app orientation** (portrait / landscape / any).
- Build-setting buttons: **Configure build settings**, **Set framerate**,
  **Set resize mode**, **Set username**, **Set clone limit**.

### Orientation preview

The first mobile block you use prompts for portrait vs landscape and resizes the
editor stage (`360×640` portrait / `640×360` landscape) so you can preview the
app's shape. You can re-trigger this any time with **preview app as [mode] in
editor**, and it also sets the app's locked orientation.

### Overriding sources (for forks / offline networks)

Set these globals before the extension loads:

- `window.MOBILE_SCAFFOLDING_URL` — alternate scaffolding runtime URL.
- `window.MOBILE_APP_INVENTOR_URL` — alternate App Inventor URL.

## License

LGPL-3.0-only, matching the surrounding extension repository.
