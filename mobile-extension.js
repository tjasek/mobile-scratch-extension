/**
 * mobile-extension.js — Mobile events extension for Cocrea / Gandi IDE / TurboWarp.
 *
 * Brings AppInventor-style mobile capabilities to Scratch projects:
 *   - Touch events (tap / press / move / release) with touch coordinates.
 *   - Scroll / swipe events with direction and delta reporters.
 *   - Screen orientation events (portrait / landscape) + boolean checks.
 *   - Device orientation sensor (azimuth / pitch / roll) mirroring AppInventor's
 *     OrientationSensor.
 *   - Device motion / shake detection mirroring AppInventor's AccelerometerSensor.
 *   - A one-click "Build mobile app" button that hands the current project off to
 *     the TurboWarp packager so it can be wrapped as an installable mobile app.
 *
 * The extension is written to be compatible with both the Gandi/Cocrea extension
 * runtime and vanilla TurboWarp. Where the two differ (e.g. button `onClick` vs
 * `func`), the code degrades gracefully.
 */

(function (Scratch) {
  'use strict';

  const {
    runtime,
    ArgumentType,
    BlockType,
    Cast,
  } = Scratch;

  const EXTENSION_ID = 'mobileEvents';

  // The Scaffolding runtime is the same minimal Scratch player the TurboWarp
  // packager embeds into standalone apps. We fetch it once at build time and
  // inline it so the produced app is fully offline / self-contained.
  // Forks can override these by setting the globals before the extension loads.
  const SCAFFOLDING_URL =
    (typeof window !== 'undefined' && window.MOBILE_SCAFFOLDING_URL) ||
    'https://packager.turbowarp.org/scaffolding/scaffolding-full.js';

  // JSZip is used to assemble the downloadable Cordova/native project archive.
  const JSZIP_URL =
    (typeof window !== 'undefined' && window.MOBILE_JSZIP_URL) ||
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

  // Optional cloud build service endpoint. When set, the extension can POST the
  // Cordova project zip and receive a compiled APK/IPA back — no local toolchain
  // required. It must accept a multipart upload of the project zip and expose a
  // simple job/status/download flow (Cordova-compatible, e.g. VoltBuilder-style).
  // Left empty by default because no universal free public endpoint exists; set
  //   window.MOBILE_BUILD_SERVICE_URL = 'https://your-build-endpoint/'
  // before the extension loads, or use the "set cloud build service" block.
  const DEFAULT_BUILD_SERVICE_URL =
    (typeof window !== 'undefined' && window.MOBILE_BUILD_SERVICE_URL) || '';

  // App Inventor WebViewer + Form component versions (from AppInventor sources).
  const AI_WEBVIEWER_VERSION = 11;
  const AI_FORM_VERSION = 32;
  const AI_YOUNG_ANDROID_VERSION = 237;
  const AI_YA_VERSION = '208';

  // Standard mobile viewport presets (portrait). Landscape swaps the axes.
  const VIEWPORT_PRESETS = {
    portrait: { width: 360, height: 640 },
    landscape: { width: 640, height: 360 },
  };

  // ------------------------------------------------------------------
  //  Small helpers
  // ------------------------------------------------------------------

  const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
  const round2 = (n) => Math.round(n * 100) / 100;

  /**
   * Translate a client (page) coordinate into Scratch stage coordinates
   * (-240..240 on X, -180..180 on Y, origin at center, Y up).
   * @param {number} clientX
   * @param {number} clientY
   * @param {HTMLCanvasElement} canvas
   * @returns {{x:number, y:number}}
   */
  function clientToStage(clientX, clientY, canvas) {
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const nativeWidth = canvas.width / (window.devicePixelRatio || 1);
    const nativeHeight = canvas.height / (window.devicePixelRatio || 1);
    // Fall back to the on-screen size if the backing store size is unusual.
    const width = rect.width || nativeWidth || 480;
    const height = rect.height || nativeHeight || 360;
    const relX = (clientX - rect.left) / width; // 0..1
    const relY = (clientY - rect.top) / height; // 0..1
    const x = clamp(relX * 480 - 240, -240, 240);
    const y = clamp(180 - relY * 360, -180, 180);
    return { x: round2(x), y: round2(y) };
  }

  // ------------------------------------------------------------------
  //  Extension class
  // ------------------------------------------------------------------

  class MobileEventsExtension {
    constructor(_runtime) {
      this.runtime = _runtime;

      // --- touch state -------------------------------------------------
      this.touchX = 0;
      this.touchY = 0;
      this.touchCount = 0;
      this.isTouching = false;

      // --- scroll / swipe state ---------------------------------------
      this.scrollDeltaX = 0;
      this.scrollDeltaY = 0;
      this.lastScrollDirection = '';
      this._scrollResetTimer = null;

      // --- orientation state ------------------------------------------
      this.azimuth = 0; // compass heading, 0..360
      this.pitch = 0; // front/back tilt, degrees
      this.roll = 0; // left/right tilt, degrees
      this.orientationMode = this._readOrientationMode();

      // --- motion / shake state ---------------------------------------
      this.accelX = 0;
      this.accelY = 0;
      this.accelZ = 0;
      this.lastShakeTime = 0;

      // --- app build configuration ------------------------------------
      // The build settings below mirror the options the TurboWarp packager
      // exposes for a packaged project.
      this.appConfig = {
        name: 'My Mobile App',
        packageId: 'world.cocrea.myapp',
        orientation: 'default', // default | portrait | landscape
        fullscreen: true,
        background: '#000000',
        // packager-equivalent runtime settings
        autoStart: true, // "start with green flag" automatically
        turbo: false, // turbo mode
        framerate: 30, // 30 or 60 (fps)
        interpolation: false, // frame interpolation (smooth 60fps)
        highQualityPen: false, // high quality render / pen
        fencing: true, // keep sprites on stage
        miscLimits: true, // misc runtime limits
        maxClones: 300, // clone limit (Infinity if disabled)
        resizeMode: 'preserve-ratio', // preserve-ratio | stretch | dynamic-resize
        username: 'player', // default username
      };

      // Cloud build service endpoint (empty until configured).
      this.buildServiceUrl = DEFAULT_BUILD_SERVICE_URL;

      // Cached fetch of the scaffolding runtime so repeated builds are fast.
      this._scaffoldingPromise = null;
      this._buildStatus = 'idle';

      // --- orientation preview / prompt -------------------------------
      // When the user first uses a mobile block we ask them to choose the app
      // orientation and then adjust the editor stage so they can preview it.
      this._orientationChosen = false;
      this._previewApplied = false;

      this._bindEvents();
    }

    // ----------------------------------------------------------------
    //  Event wiring
    // ----------------------------------------------------------------

    _getCanvas() {
      return (
        (this.runtime && this.runtime.renderer && this.runtime.renderer.canvas) ||
        null
      );
    }

    _startHats(opcode, fields) {
      // Guarded so a missing runtime API never crashes event handling.
      if (this.runtime && typeof this.runtime.startHats === 'function') {
        this.runtime.startHats(`${EXTENSION_ID}_${opcode}`, fields);
      }
    }

    // ----------------------------------------------------------------
    //  Orientation prompt + editor preview
    //
    //  The first time any mobile block runs we ask the user to pick the app
    //  orientation, then resize the editor stage to a matching phone viewport
    //  so they can preview how the finished app will look.
    // ----------------------------------------------------------------

    _ensureOrientationChosen() {
      if (this._orientationChosen) return;
      // Guard against multiple synchronous calls before the prompt resolves.
      this._orientationChosen = true;

      let choice = null;
      try {
        if (typeof prompt === 'function') {
          const answer = prompt(
            'Mobile Events: how should your app be oriented?\n\n' +
              'Type "portrait" or "landscape" (leave blank for any/default).',
            this.appConfig.orientation === 'default'
              ? 'portrait'
              : this.appConfig.orientation
          );
          if (answer != null) {
            const normalized = String(answer).trim().toLowerCase();
            if (normalized === 'portrait' || normalized === 'landscape') {
              choice = normalized;
            } else if (normalized === '' || normalized === 'any' || normalized === 'default') {
              choice = 'default';
            }
          }
        }
      } catch (e) {
        /* non-interactive environment — keep current setting */
      }

      if (choice) {
        this.appConfig.orientation = choice;
      }
      this._applyEditorPreview();
    }

    /**
     * Resize the editor stage to a phone-shaped viewport that matches the
     * chosen orientation, giving a live preview of the app's aspect ratio.
     */
    _applyEditorPreview() {
      const mode =
        this.appConfig.orientation === 'landscape' ? 'landscape' : 'portrait';
      const preset = VIEWPORT_PRESETS[mode];
      if (!preset) return;
      try {
        // TurboWarp/Gandi VMs expose setStageSize for custom stage dimensions.
        if (this.runtime && typeof this.runtime.setStageSize === 'function') {
          this.runtime.setStageSize(preset.width, preset.height);
          this._previewApplied = true;
        } else if (
          this.runtime &&
          this.runtime.vm &&
          typeof this.runtime.vm.setStageSize === 'function'
        ) {
          this.runtime.vm.setStageSize(preset.width, preset.height);
          this._previewApplied = true;
        }
      } catch (e) {
        // Stage resizing is a preview nicety; never let it break blocks.
        console.warn('[Mobile Events] could not resize stage for preview:', e);
      }
    }

    _readOrientationMode() {
      try {
        if (window.screen && window.screen.orientation && window.screen.orientation.type) {
          return window.screen.orientation.type.indexOf('portrait') === 0
            ? 'portrait'
            : 'landscape';
        }
      } catch (e) {
        /* screen.orientation may be unavailable */
      }
      return window.innerHeight >= window.innerWidth ? 'portrait' : 'landscape';
    }

    _bindEvents() {
      const canvas = this._getCanvas();
      const target = canvas || document;

      // ---- Pointer / touch events -----------------------------------
      // Pointer events unify mouse + touch and are widely supported on mobile.
      const onPointerDown = (event) => {
        const point = this._pointFromEvent(event, canvas);
        this.touchX = point.x;
        this.touchY = point.y;
        this.isTouching = true;
        this.touchCount = this._countTouches(event, 1);
        this._startHats('whenTouched');
      };
      const onPointerMove = (event) => {
        if (!this.isTouching) return;
        const point = this._pointFromEvent(event, canvas);
        this.touchX = point.x;
        this.touchY = point.y;
        this._startHats('whenTouchMoved');
      };
      const onPointerUp = (event) => {
        if (this.isTouching) {
          this._startHats('whenTouchReleased');
        }
        this.isTouching = false;
        this.touchCount = 0;
      };

      if (window.PointerEvent) {
        target.addEventListener('pointerdown', onPointerDown, { passive: true });
        target.addEventListener('pointermove', onPointerMove, { passive: true });
        // Release can happen off-canvas, so listen on window.
        window.addEventListener('pointerup', onPointerUp, { passive: true });
        window.addEventListener('pointercancel', onPointerUp, { passive: true });
      } else {
        // Fallback for older browsers.
        target.addEventListener('touchstart', onPointerDown, { passive: true });
        target.addEventListener('touchmove', onPointerMove, { passive: true });
        window.addEventListener('touchend', onPointerUp, { passive: true });
        target.addEventListener('mousedown', onPointerDown, { passive: true });
        target.addEventListener('mousemove', onPointerMove, { passive: true });
        window.addEventListener('mouseup', onPointerUp, { passive: true });
      }

      // ---- Scroll / wheel / swipe -----------------------------------
      const onWheel = (event) => {
        this.scrollDeltaX = event.deltaX || 0;
        this.scrollDeltaY = event.deltaY || 0;
        this.lastScrollDirection = this._directionFromDelta(
          this.scrollDeltaX,
          this.scrollDeltaY
        );
        this._startHats('whenScrolled', {
          DIRECTION: this.lastScrollDirection,
        });
        // Auto-clear the transient delta shortly after the gesture.
        clearTimeout(this._scrollResetTimer);
        this._scrollResetTimer = setTimeout(() => {
          this.scrollDeltaX = 0;
          this.scrollDeltaY = 0;
        }, 60);
      };
      target.addEventListener('wheel', onWheel, { passive: true });

      // Touch-based swipe detection (fires the same scroll hat).
      this._swipeStart = null;
      const onSwipeStart = (event) => {
        const t = event.touches && event.touches[0];
        if (t) this._swipeStart = { x: t.clientX, y: t.clientY };
      };
      const onSwipeEnd = (event) => {
        if (!this._swipeStart) return;
        const t = (event.changedTouches && event.changedTouches[0]) || null;
        if (!t) return;
        const dx = t.clientX - this._swipeStart.x;
        const dy = t.clientY - this._swipeStart.y;
        this._swipeStart = null;
        if (Math.abs(dx) < 30 && Math.abs(dy) < 30) return; // too small
        this.scrollDeltaX = dx;
        this.scrollDeltaY = dy;
        this.lastScrollDirection = this._directionFromDelta(dx, dy);
        this._startHats('whenScrolled', { DIRECTION: this.lastScrollDirection });
      };
      target.addEventListener('touchstart', onSwipeStart, { passive: true });
      window.addEventListener('touchend', onSwipeEnd, { passive: true });

      // ---- Screen orientation change --------------------------------
      const onOrientationChange = () => {
        const mode = this._readOrientationMode();
        if (mode !== this.orientationMode) {
          this.orientationMode = mode;
          this._startHats('whenOrientationChanged', { MODE: mode });
          if (mode === 'portrait') {
            this._startHats('whenPortrait');
          } else {
            this._startHats('whenLandscape');
          }
        }
      };
      window.addEventListener('resize', onOrientationChange);
      window.addEventListener('orientationchange', onOrientationChange);
      try {
        if (window.screen && window.screen.orientation) {
          window.screen.orientation.addEventListener('change', onOrientationChange);
        }
      } catch (e) {
        /* ignore */
      }

      // ---- Device orientation sensor (azimuth/pitch/roll) -----------
      window.addEventListener('deviceorientation', (event) => {
        // alpha: compass, beta: front-back tilt, gamma: left-right tilt.
        if (event.alpha != null) this.azimuth = round2(event.alpha);
        if (event.beta != null) this.pitch = round2(event.beta);
        if (event.gamma != null) this.roll = round2(event.gamma);
        this._startHats('whenTilted');
      });

      // ---- Device motion / shake ------------------------------------
      window.addEventListener('devicemotion', (event) => {
        const acc =
          event.accelerationIncludingGravity || event.acceleration || null;
        if (!acc) return;
        this.accelX = round2(acc.x || 0);
        this.accelY = round2(acc.y || 0);
        this.accelZ = round2(acc.z || 0);
        const magnitude = Math.sqrt(
          this.accelX * this.accelX +
            this.accelY * this.accelY +
            this.accelZ * this.accelZ
        );
        // Threshold roughly matching AppInventor's shake sensitivity.
        const now = Date.now();
        if (magnitude > 22 && now - this.lastShakeTime > 500) {
          this.lastShakeTime = now;
          this._startHats('whenShaken');
        }
      });
    }

    _pointFromEvent(event, canvas) {
      let clientX;
      let clientY;
      if (event.touches && event.touches.length) {
        clientX = event.touches[0].clientX;
        clientY = event.touches[0].clientY;
      } else if (event.changedTouches && event.changedTouches.length) {
        clientX = event.changedTouches[0].clientX;
        clientY = event.changedTouches[0].clientY;
      } else {
        clientX = event.clientX;
        clientY = event.clientY;
      }
      return clientToStage(clientX, clientY, canvas);
    }

    _countTouches(event, fallback) {
      if (event.touches && typeof event.touches.length === 'number') {
        return event.touches.length || fallback;
      }
      return fallback;
    }

    _directionFromDelta(dx, dy) {
      if (Math.abs(dx) > Math.abs(dy)) {
        return dx > 0 ? 'right' : 'left';
      }
      // Note: positive wheel deltaY means scrolling *down*.
      return dy > 0 ? 'down' : 'up';
    }

    // ----------------------------------------------------------------
    //  getInfo — block definitions
    // ----------------------------------------------------------------

    getInfo() {
      return {
        id: EXTENSION_ID,
        name: 'Mobile Events',
        color1: '#4C97FF',
        color2: '#3373CC',
        color3: '#2E5FA3',
        blocks: [
          // ─── Build the app ───────────────────────────────────
          '---Build Mobile App',
          {
            blockType: BlockType.BUTTON,
            text: '📱 Download standalone app (HTML)',
            onClick: () => this.downloadHtmlApp(),
            func: 'downloadHtmlApp',
          },
          {
            blockType: BlockType.BUTTON,
            text: '🤖 Download Android project (Cordova)',
            onClick: () => this.downloadCordovaProject(),
            func: 'downloadCordovaProject',
          },
          {
            blockType: BlockType.BUTTON,
            text: '🧩 Download App Inventor project (.aia)',
            onClick: () => this.downloadAppInventorProject(),
            func: 'downloadAppInventorProject',
          },
          {
            blockType: BlockType.BUTTON,
            text: '☁️ Build APK in the cloud',
            onClick: () => this.buildInCloud(),
            func: 'buildInCloud',
          },
          '---App Info',
          {
            opcode: 'setAppName',
            blockType: BlockType.COMMAND,
            text: 'set app name to [NAME]',
            arguments: {
              NAME: {
                type: ArgumentType.STRING,
                defaultValue: 'My Mobile App',
              },
            },
          },
          {
            opcode: 'setAppPackageId',
            blockType: BlockType.COMMAND,
            text: 'set app package id to [ID]',
            arguments: {
              ID: {
                type: ArgumentType.STRING,
                defaultValue: 'world.cocrea.myapp',
              },
            },
          },
          {
            opcode: 'setAppOrientation',
            blockType: BlockType.COMMAND,
            text: 'lock app orientation to [MODE]',
            arguments: {
              MODE: {
                type: ArgumentType.STRING,
                menu: 'APP_ORIENTATION_MENU',
                defaultValue: 'default',
              },
            },
          },
          {
            opcode: 'previewOrientation',
            blockType: BlockType.COMMAND,
            text: 'preview app as [MODE] in editor',
            arguments: {
              MODE: {
                type: ArgumentType.STRING,
                menu: 'PREVIEW_ORIENTATION_MENU',
                defaultValue: 'portrait',
              },
            },
          },

          // ─── Packager-style build settings ───────────────────
          '---Build Settings',
          {
            opcode: 'setBuildToggle',
            blockType: BlockType.COMMAND,
            text: '[SETTING] [ONOFF]',
            arguments: {
              SETTING: {
                type: ArgumentType.STRING,
                menu: 'BUILD_TOGGLE_MENU',
                defaultValue: 'autoStart',
              },
              ONOFF: {
                type: ArgumentType.STRING,
                menu: 'ONOFF_MENU',
                defaultValue: 'on',
              },
            },
          },
          {
            opcode: 'setFramerate',
            blockType: BlockType.COMMAND,
            text: 'set app framerate to [FPS] fps',
            arguments: {
              FPS: {
                type: ArgumentType.NUMBER,
                defaultValue: 30,
              },
            },
          },
          {
            opcode: 'setResizeMode',
            blockType: BlockType.COMMAND,
            text: 'set app resize mode to [MODE]',
            arguments: {
              MODE: {
                type: ArgumentType.STRING,
                menu: 'RESIZE_MODE_MENU',
                defaultValue: 'preserve-ratio',
              },
            },
          },
          {
            opcode: 'setMaxClones',
            blockType: BlockType.COMMAND,
            text: 'set app clone limit to [LIMIT]',
            arguments: {
              LIMIT: {
                type: ArgumentType.NUMBER,
                defaultValue: 300,
              },
            },
          },
          {
            opcode: 'setUsername',
            blockType: BlockType.COMMAND,
            text: 'set app username to [NAME]',
            arguments: {
              NAME: {
                type: ArgumentType.STRING,
                defaultValue: 'player',
              },
            },
          },
          {
            opcode: 'setCloudBuildService',
            blockType: BlockType.COMMAND,
            text: 'set cloud build service to [URL]',
            arguments: {
              URL: {
                type: ArgumentType.STRING,
                defaultValue: 'https://your-build-service/',
              },
            },
          },
          '---',
          {
            opcode: 'downloadHtmlApp',
            blockType: BlockType.COMMAND,
            text: 'build standalone app (HTML)',
          },
          {
            opcode: 'downloadCordovaProject',
            blockType: BlockType.COMMAND,
            text: 'build Android project (Cordova)',
          },
          {
            opcode: 'getBuildStatus',
            blockType: BlockType.REPORTER,
            text: 'build status',
          },

          // ─── Touch ───────────────────────────────────────────
          '---Touch',
          {
            opcode: 'whenTouched',
            blockType: BlockType.EVENT,
            text: 'when screen touched',
            isEdgeActivated: false,
          },
          {
            opcode: 'whenTouchMoved',
            blockType: BlockType.EVENT,
            text: 'when touch moves',
            isEdgeActivated: false,
          },
          {
            opcode: 'whenTouchReleased',
            blockType: BlockType.EVENT,
            text: 'when touch released',
            isEdgeActivated: false,
          },
          {
            opcode: 'isTouchingScreen',
            blockType: BlockType.BOOLEAN,
            text: 'is screen being touched?',
          },
          {
            opcode: 'getTouchX',
            blockType: BlockType.REPORTER,
            text: 'touch x',
          },
          {
            opcode: 'getTouchY',
            blockType: BlockType.REPORTER,
            text: 'touch y',
          },
          {
            opcode: 'getTouchCount',
            blockType: BlockType.REPORTER,
            text: 'number of touches',
          },

          // ─── Scroll / swipe ──────────────────────────────────
          '---Scroll & Swipe',
          {
            opcode: 'whenScrolled',
            blockType: BlockType.EVENT,
            text: 'when scrolled [DIRECTION]',
            isEdgeActivated: false,
            arguments: {
              DIRECTION: {
                type: ArgumentType.STRING,
                menu: 'SCROLL_DIR_MENU',
                defaultValue: 'any',
              },
            },
          },
          {
            opcode: 'getScrollDirection',
            blockType: BlockType.REPORTER,
            text: 'last scroll direction',
          },
          {
            opcode: 'getScrollDelta',
            blockType: BlockType.REPORTER,
            text: 'scroll delta [AXIS]',
            arguments: {
              AXIS: {
                type: ArgumentType.STRING,
                menu: 'AXIS_MENU',
                defaultValue: 'y',
              },
            },
          },

          // ─── Orientation ─────────────────────────────────────
          '---Orientation',
          {
            opcode: 'whenPortrait',
            blockType: BlockType.EVENT,
            text: 'when rotated to portrait',
            isEdgeActivated: false,
          },
          {
            opcode: 'whenLandscape',
            blockType: BlockType.EVENT,
            text: 'when rotated to landscape',
            isEdgeActivated: false,
          },
          {
            opcode: 'whenOrientationChanged',
            blockType: BlockType.EVENT,
            text: 'when orientation changes',
            isEdgeActivated: false,
          },
          {
            opcode: 'isOrientation',
            blockType: BlockType.BOOLEAN,
            text: 'screen is [MODE]?',
            arguments: {
              MODE: {
                type: ArgumentType.STRING,
                menu: 'ORIENTATION_MENU',
                defaultValue: 'portrait',
              },
            },
          },
          {
            opcode: 'getOrientation',
            blockType: BlockType.REPORTER,
            text: 'screen orientation',
          },

          // ─── Device tilt / motion ────────────────────────────
          '---Device Sensors',
          {
            opcode: 'requestSensorPermission',
            blockType: BlockType.COMMAND,
            text: 'enable motion sensors',
          },
          {
            opcode: 'whenTilted',
            blockType: BlockType.EVENT,
            text: 'when device tilts',
            isEdgeActivated: false,
          },
          {
            opcode: 'whenShaken',
            blockType: BlockType.EVENT,
            text: 'when device shaken',
            isEdgeActivated: false,
          },
          {
            opcode: 'getTilt',
            blockType: BlockType.REPORTER,
            text: 'device [ANGLE]',
            arguments: {
              ANGLE: {
                type: ArgumentType.STRING,
                menu: 'ANGLE_MENU',
                defaultValue: 'pitch',
              },
            },
          },
          {
            opcode: 'getAcceleration',
            blockType: BlockType.REPORTER,
            text: 'acceleration [AXIS3]',
            arguments: {
              AXIS3: {
                type: ArgumentType.STRING,
                menu: 'AXIS3_MENU',
                defaultValue: 'x',
              },
            },
          },
        ],

        menus: {
          APP_ORIENTATION_MENU: [
            { text: 'any', value: 'default' },
            { text: 'portrait', value: 'portrait' },
            { text: 'landscape', value: 'landscape' },
          ],
          PREVIEW_ORIENTATION_MENU: [
            { text: 'portrait', value: 'portrait' },
            { text: 'landscape', value: 'landscape' },
          ],
          BUILD_TOGGLE_MENU: [
            { text: 'start with green flag', value: 'autoStart' },
            { text: 'turbo mode', value: 'turbo' },
            { text: 'frame interpolation', value: 'interpolation' },
            { text: 'high quality pen', value: 'highQualityPen' },
            { text: 'keep sprites on stage (fencing)', value: 'fencing' },
            { text: 'runtime limits', value: 'miscLimits' },
            { text: 'fullscreen', value: 'fullscreen' },
          ],
          ONOFF_MENU: [
            { text: 'on', value: 'on' },
            { text: 'off', value: 'off' },
          ],
          RESIZE_MODE_MENU: [
            { text: 'preserve ratio', value: 'preserve-ratio' },
            { text: 'stretch', value: 'stretch' },
            { text: 'resize (dynamic)', value: 'dynamic-resize' },
          ],
          SCROLL_DIR_MENU: [
            { text: 'any', value: 'any' },
            { text: 'up', value: 'up' },
            { text: 'down', value: 'down' },
            { text: 'left', value: 'left' },
            { text: 'right', value: 'right' },
          ],
          AXIS_MENU: [
            { text: 'x', value: 'x' },
            { text: 'y', value: 'y' },
          ],
          ORIENTATION_MENU: [
            { text: 'portrait', value: 'portrait' },
            { text: 'landscape', value: 'landscape' },
          ],
          ANGLE_MENU: [
            { text: 'azimuth (compass)', value: 'azimuth' },
            { text: 'pitch (front-back)', value: 'pitch' },
            { text: 'roll (left-right)', value: 'roll' },
          ],
          AXIS3_MENU: [
            { text: 'x', value: 'x' },
            { text: 'y', value: 'y' },
            { text: 'z', value: 'z' },
          ],
        },
      };
    }

    // ----------------------------------------------------------------
    //  Hat-block predicates
    //
    //  Event hats with a menu argument (whenScrolled) need a predicate so the
    //  matching direction is honored. startHats passes the block's own field
    //  values in `args`; we compare against the fields we fired with.
    // ----------------------------------------------------------------

    whenScrolled(args) {
      this._ensureOrientationChosen();
      const wanted = Cast.toString(args.DIRECTION);
      if (wanted === 'any' || wanted === '') return true;
      return wanted === this.lastScrollDirection;
    }

    // The remaining event hats have no argument and always run when started.
    whenTouched() {
      this._ensureOrientationChosen();
      return true;
    }

    whenTouchMoved() {
      this._ensureOrientationChosen();
      return true;
    }

    whenTouchReleased() {
      this._ensureOrientationChosen();
      return true;
    }

    whenPortrait() {
      this._ensureOrientationChosen();
      return true;
    }

    whenLandscape() {
      this._ensureOrientationChosen();
      return true;
    }

    whenOrientationChanged() {
      this._ensureOrientationChosen();
      return true;
    }

    whenTilted() {
      this._ensureOrientationChosen();
      return true;
    }

    whenShaken() {
      this._ensureOrientationChosen();
      return true;
    }

    // ----------------------------------------------------------------
    //  Touch reporters
    // ----------------------------------------------------------------

    isTouchingScreen() {
      this._ensureOrientationChosen();
      return this.isTouching;
    }

    getTouchX() {
      this._ensureOrientationChosen();
      return this.touchX;
    }

    getTouchY() {
      return this.touchY;
    }

    getTouchCount() {
      return this.touchCount;
    }

    // ----------------------------------------------------------------
    //  Scroll reporters
    // ----------------------------------------------------------------

    getScrollDirection() {
      return this.lastScrollDirection;
    }

    getScrollDelta(args) {
      return Cast.toString(args.AXIS) === 'x'
        ? this.scrollDeltaX
        : this.scrollDeltaY;
    }

    // ----------------------------------------------------------------
    //  Orientation reporters
    // ----------------------------------------------------------------

    isOrientation(args) {
      this._ensureOrientationChosen();
      return Cast.toString(args.MODE) === this.orientationMode;
    }

    getOrientation() {
      this._ensureOrientationChosen();
      return this.orientationMode;
    }

    // ----------------------------------------------------------------
    //  Device sensor reporters
    // ----------------------------------------------------------------

    getTilt(args) {
      this._ensureOrientationChosen();
      switch (Cast.toString(args.ANGLE)) {
        case 'azimuth':
          return this.azimuth;
        case 'roll':
          return this.roll;
        case 'pitch':
        default:
          return this.pitch;
      }
    }

    getAcceleration(args) {
      switch (Cast.toString(args.AXIS3)) {
        case 'y':
          return this.accelY;
        case 'z':
          return this.accelZ;
        case 'x':
        default:
          return this.accelX;
      }
    }

    // ----------------------------------------------------------------
    //  Sensor permission (iOS 13+ requires an explicit user gesture)
    // ----------------------------------------------------------------

    requestSensorPermission() {
      const requests = [];
      try {
        if (
          typeof DeviceMotionEvent !== 'undefined' &&
          typeof DeviceMotionEvent.requestPermission === 'function'
        ) {
          requests.push(DeviceMotionEvent.requestPermission());
        }
        if (
          typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function'
        ) {
          requests.push(DeviceOrientationEvent.requestPermission());
        }
      } catch (e) {
        /* Permission API not present — sensors work without a prompt. */
      }
      if (requests.length === 0) return;
      // Return the promise so the VM waits for the prompt to resolve.
      return Promise.all(requests).catch(() => {});
    }

    // ----------------------------------------------------------------
    //  App build configuration
    // ----------------------------------------------------------------

    setAppName(args) {
      const name = Cast.toString(args.NAME).trim();
      if (name) this.appConfig.name = name;
    }

    setAppPackageId(args) {
      const id = Cast.toString(args.ID).trim();
      // Basic reverse-domain sanitization; native tooling is strict about this.
      if (id) {
        this.appConfig.packageId = id
          .toLowerCase()
          .replace(/[^a-z0-9._]/g, '')
          .replace(/\.{2,}/g, '.')
          .replace(/^\.|\.$/g, '');
      }
    }

    setAppOrientation(args) {
      const mode = Cast.toString(args.MODE);
      if (['default', 'portrait', 'landscape'].includes(mode)) {
        this.appConfig.orientation = mode;
        this._applyEditorPreview();
      }
    }

    previewOrientation(args) {
      const mode = Cast.toString(args.MODE);
      if (mode === 'portrait' || mode === 'landscape') {
        this.appConfig.orientation = mode;
        this._orientationChosen = true;
        this._applyEditorPreview();
      }
    }

    setBuildToggle(args) {
      const setting = Cast.toString(args.SETTING);
      const on = Cast.toString(args.ONOFF) === 'on';
      if (Object.prototype.hasOwnProperty.call(this.appConfig, setting)) {
        this.appConfig[setting] = on;
      }
    }

    setFramerate(args) {
      const fps = Cast.toNumber(args.FPS);
      // Clamp to sane bounds; packager commonly uses 30 or 60.
      this.appConfig.framerate = clamp(Math.round(fps) || 30, 1, 240);
    }

    setResizeMode(args) {
      const mode = Cast.toString(args.MODE);
      if (['preserve-ratio', 'stretch', 'dynamic-resize'].includes(mode)) {
        this.appConfig.resizeMode = mode;
      }
    }

    setMaxClones(args) {
      const limit = Cast.toNumber(args.LIMIT);
      // A negative or zero value means "unlimited".
      this.appConfig.maxClones = limit > 0 ? Math.round(limit) : Infinity;
    }

    setUsername(args) {
      const name = Cast.toString(args.NAME).trim();
      this.appConfig.username = name || 'player';
    }

    setCloudBuildService(args) {
      this.buildServiceUrl = Cast.toString(args.URL).trim();
    }

    getBuildStatus() {
      return this._buildStatus;
    }

    // ----------------------------------------------------------------
    //  Build: export the running project to a .sb3 blob
    //
    //  This mirrors what the packager does — it takes the live VM's project
    //  and serializes it. We support the common VM export APIs and fall back
    //  gracefully.
    // ----------------------------------------------------------------

    async _exportProjectSb3() {
      const vm =
        (this.runtime && this.runtime.vm) ||
        (typeof window !== 'undefined' && window.vm) ||
        null;

      // Newer VMs expose saveProjectSb3() returning a Blob (or Uint8Array).
      if (vm && typeof vm.saveProjectSb3 === 'function') {
        const result = await vm.saveProjectSb3('uint8array').catch(async () => {
          // Some VMs ignore the type argument and return a Blob.
          const blob = await vm.saveProjectSb3();
          const buf = await blob.arrayBuffer();
          return new Uint8Array(buf);
        });
        if (result instanceof Uint8Array) return result;
        if (result && typeof result.arrayBuffer === 'function') {
          return new Uint8Array(await result.arrayBuffer());
        }
      }

      throw new Error(
        'Could not export the project. This build feature needs to run inside the Cocrea/Gandi editor where the project VM is available.'
      );
    }

    // ----------------------------------------------------------------
    //  Build: fetch and cache the Scaffolding runtime source
    // ----------------------------------------------------------------

    _loadScaffoldingSource() {
      if (!this._scaffoldingPromise) {
        this._scaffoldingPromise = fetch(SCAFFOLDING_URL)
          .then((res) => {
            if (!res.ok) {
              throw new Error(`Failed to load runtime (${res.status})`);
            }
            return res.text();
          })
          .catch((err) => {
            // Reset so a later retry can attempt the fetch again.
            this._scaffoldingPromise = null;
            throw err;
          });
      }
      return this._scaffoldingPromise;
    }

    // ----------------------------------------------------------------
    //  Build: assemble the standalone HTML app
    //
    //  The output is a single HTML file that inlines both the Scratch runtime
    //  and the base64-encoded project, so it runs offline anywhere — including
    //  inside a mobile WebView.
    // ----------------------------------------------------------------

    async _generateHtmlApp() {
      const [projectData, scaffoldingSource] = await Promise.all([
        this._exportProjectSb3(),
        this._loadScaffoldingSource(),
      ]);

      const projectBase64 = this._uint8ToBase64(projectData);
      const cfg = this.appConfig;
      const escapedTitle = this._escapeHtml(cfg.name);

      // Note: the runtime is injected verbatim between script tags. It is a
      // trusted, well-known build artifact (the TurboWarp scaffolding player).
      return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src * 'self' 'unsafe-inline' 'unsafe-eval' data: blob:">
<meta name="theme-color" content="${cfg.background}">
<title>${escapedTitle}</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: ${cfg.background}; }
  #app { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
  #loading, #error {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; color: #fff; font-family: sans-serif;
    text-align: center; padding: 16px; box-sizing: border-box;
  }
  #error { display: none; }
  #error pre { max-width: 90%; white-space: pre-wrap; text-align: left; overflow: auto; }
</style>
</head>
<body>
  <div id="app"></div>
  <div id="loading">Loading…</div>
  <div id="error"><h1>Error</h1><pre id="error-text"></pre></div>

  <script>${scaffoldingSource}</script>
  <script>
    (function () {
      var PROJECT_BASE64 = "${projectBase64}";
      var appEl = document.getElementById('app');
      var loadingEl = document.getElementById('loading');
      var errorEl = document.getElementById('error');

      function showError(e) {
        console.error(e);
        loadingEl.style.display = 'none';
        errorEl.style.display = 'flex';
        document.getElementById('error-text').textContent = (e && e.stack) || String(e);
      }

      function base64ToUint8(base64) {
        var binary = atob(base64);
        var len = binary.length;
        var bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }

      // Build settings (mirrors the TurboWarp packager options).
      var SETTINGS = ${JSON.stringify(this._buildSettingsForHtml())};

      try {
        var scaffolding = new Scaffolding.Scaffolding();
        scaffolding.width = ${this._stageWidth()};
        scaffolding.height = ${this._stageHeight()};
        scaffolding.resizeMode = SETTINGS.resizeMode;
        scaffolding.setup();
        scaffolding.appendTo(appEl);
        window.scaffolding = scaffolding;
        window.vm = scaffolding.vm;
        var vm = scaffolding.vm;
        window.Scratch = {
          vm: vm,
          renderer: vm.renderer,
          audioEngine: vm.runtime.audioEngine,
          bitmapAdapter: vm.runtime.v2BitmapAdapter,
          videoProvider: vm.runtime.ioDevices.video.provider
        };

        // Apply runtime settings. Each is guarded so an older VM still runs.
        try { if (SETTINGS.username != null) scaffolding.setUsername(SETTINGS.username); } catch (e) {}
        try { if (vm.setTurboMode) vm.setTurboMode(!!SETTINGS.turbo); } catch (e) {}
        try { if (vm.setFramerate) vm.setFramerate(SETTINGS.framerate); } catch (e) {}
        try { if (vm.setInterpolation) vm.setInterpolation(!!SETTINGS.interpolation); } catch (e) {}
        try { if (vm.renderer && vm.renderer.setUseHighQualityRender) vm.renderer.setUseHighQualityRender(!!SETTINGS.highQualityPen); } catch (e) {}
        try {
          if (vm.setRuntimeOptions) {
            vm.setRuntimeOptions({
              fencing: !!SETTINGS.fencing,
              miscLimits: !!SETTINGS.miscLimits,
              maxClones: SETTINGS.maxClones === null ? Infinity : SETTINGS.maxClones
            });
          }
        } catch (e) {}

        var zipData = base64ToUint8(PROJECT_BASE64);
        scaffolding.loadProject(zipData).then(function () {
          loadingEl.style.display = 'none';
          if (SETTINGS.autoStart) {
            scaffolding.greenFlag();
          }
        }).catch(showError);
      } catch (e) {
        showError(e);
      }
    })();
  </script>
</body>
</html>`;
    }

    _stageWidth() {
      try {
        return this.runtime.stageWidth || 480;
      } catch (e) {
        return 480;
      }
    }

    _stageHeight() {
      try {
        return this.runtime.stageHeight || 360;
      } catch (e) {
        return 360;
      }
    }

    /**
     * Serialize the runtime-relevant build settings for embedding in the HTML.
     * Infinity is JSON-unsafe, so maxClones becomes null to mean "unlimited".
     */
    _buildSettingsForHtml() {
      const cfg = this.appConfig;
      return {
        autoStart: !!cfg.autoStart,
        turbo: !!cfg.turbo,
        framerate: cfg.framerate || 30,
        interpolation: !!cfg.interpolation,
        highQualityPen: !!cfg.highQualityPen,
        fencing: !!cfg.fencing,
        miscLimits: !!cfg.miscLimits,
        maxClones: cfg.maxClones === Infinity ? null : cfg.maxClones,
        resizeMode: cfg.resizeMode || 'preserve-ratio',
        username: cfg.username || 'player',
      };
    }

    // ----------------------------------------------------------------
    //  Build entry points (also usable as command blocks)
    // ----------------------------------------------------------------

    async downloadHtmlApp() {
      try {
        this._buildStatus = 'building';
        const html = await this._generateHtmlApp();
        const blob = new Blob([html], { type: 'text/html' });
        this._triggerDownload(blob, `${this._safeFileName(this.appConfig.name)}.html`);
        this._buildStatus = 'done';
      } catch (e) {
        this._buildStatus = 'error: ' + (e && e.message ? e.message : e);
        this._reportBuildError(e);
      }
    }

    async downloadCordovaProject() {
      try {
        this._buildStatus = 'building';
        const [html, JSZip] = await Promise.all([
          this._generateHtmlApp(),
          this._loadJSZip(),
        ]);
        const zip = new JSZip();
        const cfg = this.appConfig;

        // A minimal but complete Cordova project layout. After unzipping:
        //   cordova platform add android
        //   cordova build android      → produces an installable .apk
        zip.file('www/index.html', html);
        zip.file('config.xml', this._generateCordovaConfig());
        zip.file('package.json', this._generateCordovaPackageJson());
        zip.file('README.txt', this._generateCordovaReadme());

        const blob = await zip.generateAsync({ type: 'blob' });
        this._triggerDownload(
          blob,
          `${this._safeFileName(cfg.name)}-cordova.zip`
        );
        this._buildStatus = 'done';
      } catch (e) {
        this._buildStatus = 'error: ' + (e && e.message ? e.message : e);
        this._reportBuildError(e);
      }
    }

    // ----------------------------------------------------------------
    //  App Inventor (.aia) export
    //
    //  App Inventor imports its own .aia format — it cannot read a Scratch
    //  project directly. So we emit a valid single-screen .aia whose Screen1
    //  hosts a full-screen WebViewer pointing at the bundled app, and we ship
    //  the standalone HTML as an asset. The user opens it in App Inventor,
    //  builds an APK, and (because WebViewer can't load a bundled asset via a
    //  normal URL) hosts the HTML and sets the WebViewer HomeUrl. Instructions
    //  are included in the archive.
    // ----------------------------------------------------------------

    async downloadAppInventorProject() {
      try {
        this._buildStatus = 'building';
        const [html, JSZip] = await Promise.all([
          this._generateHtmlApp(),
          this._loadJSZip(),
        ]);
        const zip = new JSZip();
        const cfg = this.appConfig;
        const projectName = this._aiProjectName(cfg.name);
        const user = 'ai_cocrea';
        const base = `src/appinventor/${user}/${projectName}`;

        zip.file('youngandroidproject/project.properties', this._generateAiProjectProperties(projectName, user));
        zip.file(`${base}/Screen1.scm`, this._generateAiScm(projectName));
        zip.file(`${base}/Screen1.bky`, this._generateAiBky());
        zip.file(`${base}/Screen1.yail`, this._generateAiYail(projectName, user));
        // Ship the runnable app as an asset the user can host.
        zip.file('assets/app.html', html);
        zip.file('README.txt', this._generateAiReadme(cfg));

        const blob = await zip.generateAsync({ type: 'blob' });
        this._triggerDownload(blob, `${this._safeFileName(cfg.name)}.aia`);
        this._buildStatus = 'done';
      } catch (e) {
        this._buildStatus = 'error: ' + (e && e.message ? e.message : e);
        this._reportBuildError(e);
      }
    }

    // ----------------------------------------------------------------
    //  Cloud build — POST the Cordova zip to a build service and get an APK.
    //
    //  Requires a configured, Cordova-compatible build endpoint (set via the
    //  "set cloud build service" block or window.MOBILE_BUILD_SERVICE_URL).
    //  The endpoint contract this expects:
    //    POST  <url>            multipart form field "project" = zip
    //          → 200 JSON { id }  OR  200 with the binary APK directly
    //    GET   <url>status/<id> → JSON { status: 'pending'|'done'|'error',
    //                                    downloadUrl?, message? }
    // ----------------------------------------------------------------

    async buildInCloud() {
      if (!this.buildServiceUrl) {
        this._buildStatus = 'error: no cloud build service configured';
        this._reportBuildError(
          new Error(
            'No cloud build service is configured. Use the "set cloud build service" ' +
              'block (or window.MOBILE_BUILD_SERVICE_URL) to point at a Cordova-compatible ' +
              'build endpoint, then try again. You can also use the Cordova or App Inventor ' +
              'download and build locally.'
          )
        );
        return;
      }
      try {
        this._buildStatus = 'building';
        const [html, JSZip] = await Promise.all([
          this._generateHtmlApp(),
          this._loadJSZip(),
        ]);
        const zip = new JSZip();
        zip.file('www/index.html', html);
        zip.file('config.xml', this._generateCordovaConfig());
        zip.file('package.json', this._generateCordovaPackageJson());
        const projectZip = await zip.generateAsync({ type: 'blob' });

        const form = new FormData();
        form.append('project', projectZip, `${this._safeFileName(this.appConfig.name)}.zip`);
        form.append('platform', 'android');
        form.append('appName', this.appConfig.name);
        form.append('packageId', this.appConfig.packageId);

        this._buildStatus = 'uploading';
        const res = await fetch(this.buildServiceUrl, { method: 'POST', body: form });
        if (!res.ok) {
          throw new Error(`Build service responded ${res.status}`);
        }

        const contentType = res.headers.get('content-type') || '';
        if (contentType.indexOf('application/json') === -1) {
          // Endpoint returned the APK binary directly.
          const apk = await res.blob();
          this._triggerDownload(apk, `${this._safeFileName(this.appConfig.name)}.apk`);
          this._buildStatus = 'done';
          return;
        }

        const job = await res.json();
        if (job && job.downloadUrl) {
          await this._downloadRemoteApk(job.downloadUrl);
          this._buildStatus = 'done';
          return;
        }
        if (job && job.id) {
          const downloadUrl = await this._pollCloudBuild(job.id);
          await this._downloadRemoteApk(downloadUrl);
          this._buildStatus = 'done';
          return;
        }
        throw new Error('Build service returned an unexpected response.');
      } catch (e) {
        this._buildStatus = 'error: ' + (e && e.message ? e.message : e);
        this._reportBuildError(e);
      }
    }

    async _pollCloudBuild(id) {
      const statusBase = this.buildServiceUrl.replace(/\/?$/, '/') + 'status/';
      const maxAttempts = 120; // ~10 minutes at 5s
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        this._buildStatus = `building (checking ${attempt + 1})`;
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(statusBase + encodeURIComponent(id));
        if (res.ok) {
          // eslint-disable-next-line no-await-in-loop
          const data = await res.json();
          if (data.status === 'done' && data.downloadUrl) return data.downloadUrl;
          if (data.status === 'error') {
            throw new Error(data.message || 'Cloud build failed.');
          }
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 5000));
      }
      throw new Error('Cloud build timed out.');
    }

    async _downloadRemoteApk(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not download APK (${res.status})`);
      const blob = await res.blob();
      this._triggerDownload(blob, `${this._safeFileName(this.appConfig.name)}.apk`);
    }

    _reportBuildError(e) {
      console.error('[Mobile Events] build failed:', e);
      try {
        if (typeof alert === 'function') {
          alert('Build failed: ' + (e && e.message ? e.message : e));
        }
      } catch (ignored) {
        /* non-interactive environment */
      }
    }

    // ----------------------------------------------------------------
    //  Cordova project file generators
    // ----------------------------------------------------------------

    _generateCordovaConfig() {
      const cfg = this.appConfig;
      const orientation =
        cfg.orientation === 'default' ? 'default' : cfg.orientation;
      return `<?xml version='1.0' encoding='utf-8'?>
<widget id="${this._escapeXml(cfg.packageId)}" version="1.0.0"
        xmlns="http://www.w3.org/ns/widgets"
        xmlns:cdv="http://cordova.apache.org/ns/1.0">
  <name>${this._escapeXml(cfg.name)}</name>
  <description>Mobile app built with the Cocrea Mobile Events extension.</description>
  <content src="index.html" />
  <access origin="*" />
  <allow-intent href="http://*/*" />
  <allow-intent href="https://*/*" />
  <preference name="Orientation" value="${orientation}" />
  <preference name="Fullscreen" value="${cfg.fullscreen ? 'true' : 'false'}" />
  <preference name="BackgroundColor" value="0xff000000" />
  <preference name="DisallowOverscroll" value="true" />
  <preference name="SplashMaintainAspectRatio" value="true" />
  <platform name="android">
    <preference name="android-minSdkVersion" value="24" />
  </platform>
  <platform name="ios">
    <preference name="deployment-target" value="13.0" />
  </platform>
</widget>`;
    }

    _generateCordovaPackageJson() {
      const cfg = this.appConfig;
      return JSON.stringify(
        {
          name: this._safeFileName(cfg.name).replace(/-/g, '') || 'mobileapp',
          displayName: cfg.name,
          version: '1.0.0',
          description: 'Built with the Cocrea Mobile Events extension.',
          main: 'index.js',
          devDependencies: {
            cordova: '^12.0.0',
            'cordova-android': '^13.0.0',
            'cordova-ios': '^7.1.0',
          },
          cordova: {
            platforms: ['android'],
          },
        },
        null,
        2
      );
    }

    _generateCordovaReadme() {
      const cfg = this.appConfig;
      return [
        `${cfg.name} — Cordova mobile project`,
        '',
        'This project was generated by the Cocrea Mobile Events extension.',
        'It wraps your Scratch project (already bundled offline in www/index.html)',
        'into a native mobile app.',
        '',
        'Prerequisites:',
        '  - Node.js and npm',
        '  - Apache Cordova:  npm install -g cordova',
        '  - Android: Android Studio + JDK 17 (for building an APK)',
        '  - iOS: Xcode (macOS only, for building an IPA)',
        '',
        'Build an Android APK:',
        '  1. Unzip this folder and open a terminal in it.',
        '  2. cordova platform add android',
        '  3. cordova build android',
        '     → APK appears under platforms/android/app/build/outputs/apk/',
        '',
        'Build for iOS (macOS only):',
        '  1. cordova platform add ios',
        '  2. cordova build ios',
        '  3. Open the generated Xcode project to sign and archive.',
        '',
        `App id: ${cfg.packageId}`,
        `Orientation: ${cfg.orientation}`,
      ].join('\n');
    }

    // ----------------------------------------------------------------
    //  App Inventor (.aia) file generators
    // ----------------------------------------------------------------

    _aiProjectName(name) {
      // App Inventor project names must be valid identifiers.
      let n = Cast.toString(name).replace(/[^A-Za-z0-9_]/g, '');
      if (!n || !/^[A-Za-z]/.test(n)) n = 'App' + n;
      return n;
    }

    _generateAiProjectProperties(projectName, user) {
      const cfg = this.appConfig;
      const sizing = cfg.resizeMode === 'stretch' ? 'Responsive' : 'Fixed';
      return [
        `main=appinventor.${user}.${projectName}.Screen1`,
        `name=${projectName}`,
        'assets=../assets',
        'source=../src',
        'build=../build',
        'versioncode=1',
        'versionname=1.0',
        'useslocation=False',
        `aname=${cfg.name}`,
        `sizing=${sizing}`,
        'showlistsasjson=True',
        'actionbar=False',
        'theme=Classic',
        'color.primary=&HFF3F51B5',
        'color.primary.dark=&HFF303F9F',
        'color.accent=&HFFFF4081',
      ].join('\n');
    }

    _aiScreenOrientation() {
      switch (this.appConfig.orientation) {
        case 'portrait':
          return 'portrait';
        case 'landscape':
          return 'landscape';
        default:
          return 'unspecified';
      }
    }

    _generateAiScm(projectName) {
      const cfg = this.appConfig;
      // A Form containing a single full-screen WebViewer.
      const scmObject = {
        authURL: ['*UNKNOWN*', 'localhost'],
        YaVersion: AI_YA_VERSION,
        Source: 'Form',
        Properties: {
          $Name: 'Screen1',
          $Type: 'Form',
          $Version: String(AI_FORM_VERSION),
          AppName: cfg.name,
          ScreenOrientation: this._aiScreenOrientation(),
          Scrollable: 'False',
          Sizing: cfg.resizeMode === 'stretch' ? 'Responsive' : 'Fixed',
          Title: cfg.name,
          Uuid: '0',
          $Components: [
            {
              $Name: 'AppWebViewer',
              $Type: 'WebViewer',
              $Version: String(AI_WEBVIEWER_VERSION),
              Height: '-2', // -2 = Fill Parent
              Width: '-2',
              // HomeUrl is left for the user to set to their hosted app URL.
              // See README.txt in the .aia — WebViewer cannot load a bundled
              // asset directly on all Android versions.
              HomeUrl: '',
              Uuid: '1000000001',
            },
          ],
        },
      };
      return `#|\n$JSON\n${JSON.stringify(scmObject)}\n|#`;
    }

    _generateAiBky() {
      // No blocks are required; an empty blocks canvas is valid.
      return (
        '<xml xmlns="http://www.w3.org/1999/xhtml">\n' +
        `  <yacodeblocks ya-version="${AI_YA_VERSION}" language-version="33"></yacodeblocks>\n` +
        '</xml>'
      );
    }

    _generateAiYail(projectName, user) {
      const cfg = this.appConfig;
      const form = `appinventor.${user}.${projectName}.Screen1`;
      return [
        '#|',
        '$Source $Yail',
        '|#',
        `(define-form ${form} Screen1 #t)`,
        '(require <com.google.youngandroid.runtime>)',
        ';;; Screen1',
        `(do-after-form-creation (set-and-coerce-property! 'Screen1 'AppName ${JSON.stringify(cfg.name)} 'text)`,
        ` (set-and-coerce-property! 'Screen1 'Title ${JSON.stringify(cfg.name)} 'text)`,
        ')',
        ';;; AppWebViewer',
        '(add-component Screen1 com.google.appinventor.components.runtime.WebViewer AppWebViewer)',
      ].join('\n');
    }

    _generateAiReadme(cfg) {
      return [
        `${cfg.name} — App Inventor project (.aia)`,
        '',
        'App Inventor cannot run a Scratch project directly, so this .aia gives',
        'you an App Inventor app whose screen is a full-screen WebViewer that',
        'displays your packaged app (included here as assets/app.html).',
        '',
        'How to use:',
        '  1. Go to https://ai2.appinventor.mit.edu and sign in.',
        '  2. Projects → Import project (.aia) from my computer → choose this file.',
        '  3. Host the included assets/app.html somewhere reachable by the phone',
        '     (any static host, e.g. GitHub Pages, Netlify, your own server).',
        '  4. In the Designer, select AppWebViewer and set its HomeUrl to that',
        '     hosted URL (https://.../app.html).',
        '  5. Build → App (.apk / .aab) to get an installable app.',
        '',
        'Why host the HTML? Android WebViewer needs a real URL; loading a bundled',
        'asset file is unreliable across Android versions. Hosting the one HTML',
        'file is the simplest reliable approach.',
        '',
        `App name: ${cfg.name}`,
        `Orientation: ${cfg.orientation}`,
      ].join('\n');
    }

    // ----------------------------------------------------------------
    //  Utility: JSZip loader, downloads, encoding, escaping
    // ----------------------------------------------------------------

    _loadJSZip() {
      if (typeof window !== 'undefined' && window.JSZip) {
        return Promise.resolve(window.JSZip);
      }
      // Reuse the VM's bundled JSZip if the host exposes it.
      if (
        typeof Scratch !== 'undefined' &&
        Scratch.vm &&
        Scratch.vm.exports &&
        Scratch.vm.exports.JSZip
      ) {
        return Promise.resolve(Scratch.vm.exports.JSZip);
      }
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = JSZIP_URL;
        script.onload = () => {
          if (window.JSZip) resolve(window.JSZip);
          else reject(new Error('JSZip failed to load'));
        };
        script.onerror = () => reject(new Error('Could not load JSZip from ' + JSZIP_URL));
        document.head.appendChild(script);
      });
    }

    _triggerDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
    }

    _uint8ToBase64(bytes) {
      // Chunked to avoid call-stack limits on large projects.
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
      }
      return btoa(binary);
    }

    _safeFileName(name) {
      return (
        Cast.toString(name)
          .trim()
          .replace(/[^a-z0-9]+/gi, '-')
          .replace(/^-+|-+$/g, '')
          .toLowerCase() || 'mobile-app'
      );
    }

    _escapeHtml(str) {
      return Cast.toString(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    _escapeXml(str) {
      return Cast.toString(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    }
  }

  // ------------------------------------------------------------------
  //  Register
  // ------------------------------------------------------------------
  Scratch.extensions.register(new MobileEventsExtension(runtime));
})(Scratch);
