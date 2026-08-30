# Mobile Events Extension

A JavaScript extension for **Cocrea / Gandi IDE / TurboWarp** that brings
AppInventor-style mobile capabilities to Scratch projects, plus one-click
hand-off to the [TurboWarp packager](https://packager.turbowarp.org/) so you can
turn a project into an installable mobile app.

The extension is compatible with both the Gandi/Cocrea extension runtime and
vanilla TurboWarp.

## Loading the extension

1. Serve `mobile-extension.js` at a URL (for local dev, the VSCode *Live Server*
   extension works well).
2. In the Cocrea/Gandi editor, open the **Extensions** tab → **Custom** and load
   the extension by its URL.
3. The **Mobile Events** category appears in the block palette.

## Blocks

### Mobile App
| Block | Type | Description |
| --- | --- | --- |
| 📱 Build mobile app | button | Opens the TurboWarp packager, pre-loaded with the current project id when it can be detected, so you can export a mobile app. |
| open mobile app packager | command | Same as the button, callable from scripts. |

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

The **Build mobile app** button opens the TurboWarp packager. From there:

1. Confirm the project loaded (or paste its id/`.sb3`).
2. Choose an output. For an installable app you typically export the **HTML**
   or **zip** and wrap it with a WebView shell (Cordova/Capacitor) or use the
   packager's platform-specific outputs.
3. The packager URL can be overridden by setting `window.MOBILE_PACKAGER_URL`
   before the extension loads (useful for self-hosted packager forks).

## License

LGPL-3.0-only, matching the surrounding extension repository.
