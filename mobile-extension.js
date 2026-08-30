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

  // The published URL of this extension. The built app fetches this source and
  // bakes it into the packaged runtime (the packaged project references the
  // `mobileEvents` extension and won't run without it). Cocrea/Gandi loads
  // extensions by fetching + eval (not a <script src>), so document.currentScript
  // is usually unavailable — hence we fall back to this known published URL.
  const DEFAULT_SELF_URL =
    'https://cdn.jsdelivr.net/gh/tjasek/mobile-scratch-extension@v1.2.4/mobile-extension.js';

  // Best-effort detection of the URL this extension was loaded from, with the
  // published URL as a reliable fallback. Override via window.MOBILE_EXTENSION_SELF_URL.
  const SELF_URL = (function () {
    try {
      if (typeof window !== 'undefined' && window.MOBILE_EXTENSION_SELF_URL) {
        return window.MOBILE_EXTENSION_SELF_URL;
      }
    } catch (e) { /* ignore */ }
    try {
      if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) {
        return document.currentScript.src;
      }
    } catch (e) { /* ignore */ }
    return DEFAULT_SELF_URL;
  })();

  const {
    runtime,
    ArgumentType,
    BlockType,
    TargetType,
    Cast,
  } = Scratch;

  const EXTENSION_ID = 'mobileEvents';
  const EXTENSION_VERSION = '1.2.4';

  // The Scaffolding runtime is the same minimal Scratch player the TurboWarp
  // packager embeds into standalone apps. We fetch it once at build time and
  // inline it so the produced app is fully offline / self-contained.
  // Forks can override this by setting the global before the extension loads.
  const SCAFFOLDING_URL =
    (typeof window !== 'undefined' && window.MOBILE_SCAFFOLDING_URL) ||
    'https://packager.turbowarp.org/scaffolding/scaffolding-full.js';

  // MIT App Inventor — opened so the user can embed the built HTML there.
  const APP_INVENTOR_URL =
    (typeof window !== 'undefined' && window.MOBILE_APP_INVENTOR_URL) ||
    'https://ai2.appinventor.mit.edu';

  // JSZip is only needed as a fallback, to assemble a .sb3 when the host VM
  // doesn't expose saveProjectSb3(). Loaded on demand.
  const JSZIP_URL =
    (typeof window !== 'undefined' && window.MOBILE_JSZIP_URL) ||
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

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

      // --- per-sprite touch / drag state ------------------------------
      // The VM Target currently under the active touch/drag, or null.
      this._touchedTarget = null;
      this._draggedTarget = null;
      this._dragStartClient = null;

      // --- orientation state ------------------------------------------
      this.azimuth = 0; // compass heading, 0..360
      this.pitch = 0; // front/back tilt, degrees
      this.roll = 0; // left/right tilt, degrees
      this.orientationMode = 'portrait';
      try {
        this.orientationMode = this._readOrientationMode();
      } catch (e) {
        /* keep default; nothing may block the synchronous register() call */
      }

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
        // --- packaging / output options ------------------------------
        // How to include the Scratch runtime in the built HTML:
        //   'inline' — embed the whole ~4 MB scaffolding runtime (fully
        //              offline, large file).
        //   'slim'   — reference the runtime from the CDN via <script src>
        //              (tiny file, needs a network connection at runtime).
        slimBuild: false,
        // Where the built app gets this extension's code:
        //   'baked'  — embed the CURRENTLY RUNNING extension source (includes
        //              any blocks you just added/edited). Recommended.
        //   'remote' — fetch the published CDN copy at build time (only has
        //              blocks present in the published release).
        extensionSource: 'baked',
      };

      // Cached fetch of the scaffolding runtime so repeated builds are fast.
      this._scaffoldingPromise = null;
      this._buildStatus = 'idle';

      // --- orientation preview / prompt -------------------------------
      // When the user first uses a mobile block we ask them to choose the app
      // orientation and then adjust the editor stage so they can preview it.
      this._orientationChosen = false;
      this._previewApplied = false;
      this._eventsBound = false;

      // IMPORTANT: do NOT do heavy/synchronous DOM work here. Cocrea/Gandi
      // requires Scratch.extensions.register(...) to run synchronously as the
      // script first executes; anything that throws or blocks in the
      // constructor can cause a "call extensions.register too late" error.
      // We defer event wiring to a microtask so registration completes first.
      const bind = () => this._safeBindEvents();
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(bind);
      } else if (typeof Promise !== 'undefined') {
        Promise.resolve().then(bind);
      } else {
        setTimeout(bind, 0);
      }
    }

    // ----------------------------------------------------------------
    //  Event wiring (deferred, fully guarded)
    // ----------------------------------------------------------------

    _safeBindEvents() {
      if (this._eventsBound) return;
      this._eventsBound = true;
      try {
        this._bindEvents();
      } catch (e) {
        // Event wiring is best-effort; never let it break the extension.
        console.warn('[Mobile Events] event binding failed:', e);
      }
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

    _startHats(opcode, fields, optTarget) {
      // Guarded so a missing runtime API never crashes event handling.
      // optTarget restricts the hat to a single sprite (used for per-sprite
      // events so they don't fire on every sprite / the backdrop).
      if (this.runtime && typeof this.runtime.startHats === 'function') {
        this.runtime.startHats(`${EXTENSION_ID}_${opcode}`, fields, optTarget);
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
        // Which sprite is under this touch? (client pixel coords for pick)
        const client = this._clientFromEvent(event);
        this._touchedTarget = this._pickTarget(client.x, client.y);
        this._draggedTarget = this._touchedTarget;
        this._dragStartClient = client;
        this._startHats('whenTouched');
        // Per-sprite: fire the hat ONLY on the touched sprite via optTarget so
        // it never runs for other sprites or on a backdrop tap.
        if (this._touchedTarget) {
          this._startHats('whenSpriteTouched', null, this._touchedTarget);
        }
      };
      const onPointerMove = (event) => {
        if (!this.isTouching) return;
        const point = this._pointFromEvent(event, canvas);
        this.touchX = point.x;
        this.touchY = point.y;
        this._startHats('whenTouchMoved');
        // Per-sprite drag: only after the pointer has moved a little, and only
        // on the sprite the drag started on.
        if (this._draggedTarget && this._dragStartClient) {
          const client = this._clientFromEvent(event);
          const moved =
            Math.abs(client.x - this._dragStartClient.x) +
            Math.abs(client.y - this._dragStartClient.y);
          if (moved > 3) {
            this._startHats('whenSpriteDragged', null, this._draggedTarget);
          }
        }
      };
      const onPointerUp = (event) => {
        if (this.isTouching) {
          this._startHats('whenTouchReleased');
        }
        this.isTouching = false;
        this.touchCount = 0;
        this._touchedTarget = null;
        this._draggedTarget = null;
        this._dragStartClient = null;
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

    _clientFromEvent(event) {
      if (event.touches && event.touches.length) {
        return { x: event.touches[0].clientX, y: event.touches[0].clientY };
      }
      if (event.changedTouches && event.changedTouches.length) {
        return {
          x: event.changedTouches[0].clientX,
          y: event.changedTouches[0].clientY,
        };
      }
      return { x: event.clientX, y: event.clientY };
    }

    /**
     * Return the drawableID of the top sprite at the given client (canvas
     * pixel) coordinates, or null if nothing (or the stage) is there.
     * renderer.pick expects client coordinates and returns false when nothing
     * is hit.
     */
    _pickDrawable(clientX, clientY) {
      // Resolve the sprite under a client point to a *target id* (not a raw
      // drawable id). Mirrors TurboWarp scaffolding: pick() takes canvas-space
      // coordinates (CSS pixels relative to the canvas, no DPR scaling) and
      // returns -1 or false when nothing/only the backdrop is hit.
      try {
        const renderer = this.runtime && this.runtime.renderer;
        if (!renderer || typeof renderer.pick !== 'function') return null;
        const canvas = this._getCanvas();
        let x = clientX;
        let y = clientY;
        if (canvas && typeof canvas.getBoundingClientRect === 'function') {
          const rect = canvas.getBoundingClientRect();
          x = clientX - rect.left;
          y = clientY - rect.top;
        }
        const drawableId = renderer.pick(x, y);
        // No sprite under the point (empty stage / backdrop) → not a sprite hit.
        if (drawableId === -1 || drawableId === false || drawableId == null) {
          return null;
        }
        // Map the drawable to its owning target id when the VM supports it.
        const vm = this.runtime && this.runtime.vm;
        if (vm && typeof vm.getTargetIdForDrawableId === 'function') {
          const targetId = vm.getTargetIdForDrawableId(drawableId);
          return targetId == null ? null : targetId;
        }
        // Fallback: return the drawable id itself (older/mocked runtimes).
        return drawableId;
      } catch (e) {
        return null;
      }
    }

    /**
     * Resolve a client (page) point to the actual sprite Target under it, or
     * null for the backdrop / empty stage. Returns a real VM target so it can
     * be passed to startHats() as optTarget (the reliable way to fire a hat on
     * only one sprite).
     */
    _pickTarget(clientX, clientY) {
      const pickedId = this._pickDrawable(clientX, clientY);
      if (pickedId == null) return null;
      const vm = this.runtime && this.runtime.vm;
      try {
        if (vm && typeof vm.runtime === 'object' && typeof vm.runtime.getTargetById === 'function') {
          const t = vm.runtime.getTargetById(pickedId);
          if (t && !t.isStage) return t;
        }
        if (this.runtime && typeof this.runtime.getTargetById === 'function') {
          const t = this.runtime.getTargetById(pickedId);
          if (t && !t.isStage) return t;
        }
      } catch (e) {
        /* fall through */
      }
      return null;
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
            text: '🧩 Open MIT App Inventor',
            onClick: () => this.openAppInventor(),
            func: 'openAppInventor',
          },
          '---App Info',
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
          // These are editor actions (buttons), not script blocks: clicking
          // opens a prompt/toggle so the user configures the build via the UI.
          '---Build Settings',
          {
            blockType: BlockType.BUTTON,
            text: '⚙️ Configure build settings',
            onClick: () => this.configureBuildSettings(),
            func: 'configureBuildSettings',
          },
          {
            blockType: BlockType.BUTTON,
            text: '🪶 Toggle slim build (small HTML)',
            onClick: () => this.toggleSlimBuild(),
            func: 'toggleSlimBuild',
          },
          {
            blockType: BlockType.BUTTON,
            text: '🎞 Set framerate (30/60)',
            onClick: () => this.promptFramerate(),
            func: 'promptFramerate',
          },
          {
            blockType: BlockType.BUTTON,
            text: '🖼 Set resize mode',
            onClick: () => this.promptResizeMode(),
            func: 'promptResizeMode',
          },
          {
            blockType: BlockType.BUTTON,
            text: '👤 Set username',
            onClick: () => this.promptUsername(),
            func: 'promptUsername',
          },
          {
            blockType: BlockType.BUTTON,
            text: '🔢 Set clone limit',
            onClick: () => this.promptMaxClones(),
            func: 'promptMaxClones',
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
            opcode: 'whenSpriteTouched',
            blockType: BlockType.EVENT,
            text: 'when this sprite touched',
            isEdgeActivated: false,
            filter: [TargetType.SPRITE],
          },
          {
            opcode: 'whenSpriteDragged',
            blockType: BlockType.EVENT,
            text: 'when this sprite dragged',
            isEdgeActivated: false,
            filter: [TargetType.SPRITE],
          },
          {
            opcode: 'isSpriteTouched',
            blockType: BlockType.BOOLEAN,
            text: 'is this sprite being touched?',
            filter: [TargetType.SPRITE],
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

    // Per-sprite hats. These are already scoped to the correct sprite because
    // we start them via startHats(opcode, null, target). The predicate is a
    // second safety net: it confirms util.target is the touched/dragged sprite,
    // so even a runtime that ignores optTarget won't fire on the wrong sprite
    // or on a backdrop tap.
    whenSpriteTouched(args, util) {
      this._ensureOrientationChosen();
      return this._isRunningTarget(util, this._touchedTarget);
    }

    whenSpriteDragged(args, util) {
      this._ensureOrientationChosen();
      return this._isRunningTarget(util, this._draggedTarget);
    }

    isSpriteTouched(args, util) {
      this._ensureOrientationChosen();
      // True while a touch is active and it is over this sprite right now.
      if (!this.isTouching) return false;
      const target = this._pickTarget(...this._stageTouchToClient());
      return this._isRunningTarget(util, target);
    }

    /** Is util.target the same VM target we picked? */
    _isRunningTarget(util, pickedTarget) {
      if (!pickedTarget) return false;
      const target = util && util.target;
      if (!target || target.isStage) return false;
      if (target === pickedTarget) return true;
      // Match by id as well (util.target may be a different wrapper instance).
      return target.id != null && target.id === pickedTarget.id;
    }

    /** Current touch point (stage coords) back to client pixels for picking. */
    _stageTouchToClient() {
      const canvas = this._getCanvas();
      if (!canvas || typeof canvas.getBoundingClientRect !== 'function') {
        return [0, 0];
      }
      const rect = canvas.getBoundingClientRect();
      const width = rect.width || 480;
      const height = rect.height || 360;
      const relX = (this.touchX + 240) / 480;
      const relY = (180 - this.touchY) / 360;
      return [rect.left + relX * width, rect.top + relY * height];
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

    // ----------------------------------------------------------------
    //  Build settings — configured via editor buttons (prompts/toggles),
    //  not script blocks. Each opens a small dialog and updates appConfig.
    // ----------------------------------------------------------------

    /** Toggle the on/off build settings from a single menu-driven dialog. */
    configureBuildSettings() {
      const toggles = [
        ['autoStart', 'Start with green flag'],
        ['turbo', 'Turbo mode'],
        ['interpolation', 'Frame interpolation'],
        ['highQualityPen', 'High quality pen'],
        ['fencing', 'Keep sprites on stage (fencing)'],
        ['miscLimits', 'Runtime limits'],
        ['fullscreen', 'Fullscreen'],
        // Slim build is stored as slimBuild; label describes the ON state.
        ['slimBuild', 'Slim build (load runtime from CDN — tiny file, needs internet)'],
      ];
      if (typeof prompt !== 'function') return;
      // Present the current state and let the user type which ones to flip.
      const lines = toggles.map(
        (t, i) => `${i + 1}. ${t[1]}: ${this.appConfig[t[0]] ? 'ON' : 'OFF'}`
      );
      // Extension source is a mode, not a simple toggle; expose it too.
      const extLineIndex = toggles.length + 1;
      lines.push(
        `${extLineIndex}. Extension code in build: ${
          this.appConfig.extensionSource === 'remote'
            ? 'REMOTE (published CDN copy)'
            : 'BAKED (your current blocks)'
        }`
      );
      const answer = prompt(
        'Build settings — type the numbers to TOGGLE, separated by commas ' +
          '(e.g. "1,3"). Leave blank to keep as-is.\n\n' +
          lines.join('\n'),
        ''
      );
      if (answer == null) return;
      String(answer)
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n) && n >= 1 && n <= extLineIndex)
        .forEach((n) => {
          if (n === extLineIndex) {
            // Flip between baked (default) and remote.
            this.appConfig.extensionSource =
              this.appConfig.extensionSource === 'remote' ? 'baked' : 'remote';
            return;
          }
          const key = toggles[n - 1][0];
          this.appConfig[key] = !this.appConfig[key];
        });
    }

    /**
     * Flip between a slim build (runtime loaded from the CDN — a few KB HTML
     * that needs internet) and a full inline build (~4 MB, fully offline).
     */
    toggleSlimBuild() {
      this.appConfig.slimBuild = !this.appConfig.slimBuild;
      try {
        if (typeof alert === 'function') {
          alert(
            this.appConfig.slimBuild
              ? 'Slim build ON — the exported HTML will be tiny and load the ' +
                  'Scratch runtime from the internet at runtime.'
              : 'Slim build OFF — the exported HTML will inline the full ' +
                  'runtime (~4 MB) and run completely offline.'
          );
        }
      } catch (e) {
        /* non-interactive environment */
      }
    }

    promptFramerate() {
      if (typeof prompt !== 'function') return;
      const answer = prompt('App framerate (fps), e.g. 30 or 60:', String(this.appConfig.framerate));
      if (answer == null) return;
      const fps = Number(answer);
      if (!Number.isNaN(fps)) {
        this.appConfig.framerate = clamp(Math.round(fps) || 30, 1, 240);
      }
    }

    promptResizeMode() {
      if (typeof prompt !== 'function') return;
      const answer = prompt(
        'Resize mode — type one of: preserve-ratio, stretch, dynamic-resize',
        this.appConfig.resizeMode
      );
      if (answer == null) return;
      const mode = String(answer).trim().toLowerCase();
      if (['preserve-ratio', 'stretch', 'dynamic-resize'].includes(mode)) {
        this.appConfig.resizeMode = mode;
      }
    }

    promptUsername() {
      if (typeof prompt !== 'function') return;
      const answer = prompt('Default username for the app:', this.appConfig.username);
      if (answer == null) return;
      this.appConfig.username = String(answer).trim() || 'player';
    }

    promptMaxClones() {
      if (typeof prompt !== 'function') return;
      const current =
        this.appConfig.maxClones === Infinity ? '0' : String(this.appConfig.maxClones);
      const answer = prompt('Clone limit (0 or less = unlimited):', current);
      if (answer == null) return;
      const limit = Number(answer);
      if (!Number.isNaN(limit)) {
        this.appConfig.maxClones = limit > 0 ? Math.round(limit) : Infinity;
      }
    }

    // ----------------------------------------------------------------
    //  Build: export the running project to a .sb3 blob
    //
    //  This mirrors what the packager does — it takes the live VM's project
    //  and serializes it. We support the common VM export APIs and fall back
    //  gracefully.
    // ----------------------------------------------------------------

    /**
     * Locate the live scratch-vm instance. Gandi/Cocrea does NOT expose it as
     * runtime.vm; the reliable paths are Scratch.vm, or the VM stashed on the
     * runtime's React QUESTION handler (the same trick the lpp/moreDataTypes
     * extensions use). We try every known location.
     */
    _getVM() {
      // 1. Directly on the Scratch global (most Gandi builds).
      try {
        if (typeof Scratch !== 'undefined' && Scratch.vm) return Scratch.vm;
      } catch (e) { /* ignore */ }
      // 2. Standard TurboWarp / some hosts.
      if (this.runtime && this.runtime.vm) return this.runtime.vm;
      if (typeof window !== 'undefined' && window.vm) return window.vm;
      // 3. runtime._events references (Gandi editor).
      try {
        const events = this.runtime && this.runtime._events;
        if (events && events.QUESTION) {
          const handler = Array.isArray(events.QUESTION)
            ? events.QUESTION[events.QUESTION.length - 1]
            : events.QUESTION;
          // The handler is a bound React method; grab its `this` without calling.
          const origApply = Function.prototype.apply;
          // eslint-disable-next-line no-extend-native
          Function.prototype.apply = (thisArg) => thisArg;
          let props = null;
          try {
            props = handler();
          } finally {
            // eslint-disable-next-line no-extend-native
            Function.prototype.apply = origApply;
          }
          if (props && props.props && props.props.vm) return props.props.vm;
          if (props && props.vm) return props.vm;
        }
      } catch (e) { /* ignore */ }
      // 4. The runtime may itself be a VM-like object exposing toJSON.
      if (this.runtime && typeof this.runtime.toJSON === 'function') {
        return this.runtime;
      }
      return null;
    }

    async _exportProjectSb3() {
      const vm = this._getVM();
      if (!vm) {
        throw new Error(
          'Could not find the project VM. Run this inside the Cocrea/Gandi editor with a project open.'
        );
      }

      // Preferred: a VM that can serialize a full .sb3 itself.
      if (typeof vm.saveProjectSb3 === 'function') {
        const result = await vm.saveProjectSb3('uint8array').catch(async () => {
          const blob = await vm.saveProjectSb3();
          const buf = await blob.arrayBuffer();
          return new Uint8Array(buf);
        });
        if (result instanceof Uint8Array) return result;
        if (result && typeof result.arrayBuffer === 'function') {
          return new Uint8Array(await result.arrayBuffer());
        }
      }

      // Fallback: build the .sb3 from project.json + assets ourselves.
      if (typeof vm.toJSON === 'function') {
        return this._buildSb3FromVM(vm);
      }

      throw new Error(
        'The project VM does not support export (no saveProjectSb3 or toJSON).'
      );
    }

    /**
     * Assemble a .sb3 (zip of project.json + all costume/sound assets) from a
     * VM that only exposes toJSON(). Assets are read from the runtime's
     * storage-backed asset cache on each target.
     */
    async _buildSb3FromVM(vm) {
      const JSZip = await this._loadJSZip();
      const zip = new JSZip();

      const projectJson = vm.toJSON();
      zip.file('project.json', typeof projectJson === 'string' ? projectJson : JSON.stringify(projectJson));

      // Collect unique assets (costumes + sounds) across all targets.
      const runtime = vm.runtime || this.runtime;
      const seen = {};
      const targets = (runtime && runtime.targets) || [];
      targets.forEach((target) => {
        const sprite = target && target.sprite;
        if (!sprite) return;
        const media = [].concat(sprite.costumes || [], sprite.sounds || []);
        media.forEach((item) => {
          const asset = item && item.asset;
          if (!asset) return;
          const dataFormat = asset.dataFormat || (item.md5ext && item.md5ext.split('.')[1]);
          const assetId = asset.assetId || item.assetId;
          if (!assetId || !dataFormat) return;
          const filename = `${assetId}.${dataFormat}`;
          if (seen[filename]) return;
          seen[filename] = true;
          // asset.data is a Uint8Array of the raw file bytes.
          if (asset.data) zip.file(filename, asset.data);
        });
      });

      const blob = await zip.generateAsync({ type: 'uint8array' });
      return blob instanceof Uint8Array ? blob : new Uint8Array(blob);
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
    //  Build: bake the custom extensions the project uses into data: URIs
    //
    //  The packaged project.json references custom extension ids (at minimum
    //  this Mobile Events extension). The plain runtime can't fetch them, so we
    //  fetch this extension's own source and embed it as a data: URI that the
    //  packaged VM loads before the project. Mirrors the TurboWarp packager's
    //  "bake extensions" step.
    // ----------------------------------------------------------------

    async _bakeProjectExtensions() {
      const uris = [];
      const source = await this._loadSelfSource();
      if (source) {
        // Wrap in an IIFE so the extension doesn't pollute globals in the
        // unsandboxed packaged runtime, matching the packager's wrapping.
        const wrapped = `(function(Scratch) { ${source} })(Scratch);`;
        uris.push(`data:text/javascript;,${encodeURIComponent(wrapped)}`);
      }
      return uris;
    }

    /**
     * Produce this extension's source text for baking into the build.
     *
     * By default we bake the CURRENTLY RUNNING source (appConfig.extensionSource
     * === 'baked'), reconstructed from the live class + module helpers. This is
     * what makes newly added/edited blocks actually show up in the built app —
     * the old behavior of re-fetching a pinned CDN copy only ever shipped the
     * published release's blocks.
     *
     * When appConfig.extensionSource === 'remote' we fall back to fetching the
     * published copy from SELF_URL.
     */
    async _loadSelfSource() {
      if (this.appConfig.extensionSource !== 'remote') {
        const live = this._getRunningExtensionSource();
        if (live) return live;
        // Reconstruction failed for some reason — fall through to the network
        // copy so the build still succeeds (with a warning).
        console.warn(
          '[Mobile Events] could not reconstruct the running extension source; ' +
            'falling back to the published copy at ' +
            SELF_URL
        );
      }
      try {
        const res = await fetch(SELF_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (e) {
        throw new Error(
          'Could not fetch the extension source to bundle it into the app (' +
            (e && e.message ? e.message : e) +
            '). The build needs to reach ' +
            SELF_URL +
            ' — set window.MOBILE_EXTENSION_SELF_URL if your copy lives elsewhere.'
        );
      }
    }

    /**
     * Reconstruct a complete, self-registering extension script from the code
     * that is actually running right now. This guarantees the built app has
     * exactly the blocks you see in the editor, including any you just added.
     *
     * The reconstruction re-declares the module-level constants and helpers the
     * class depends on, then the class itself (via Function.prototype.toString),
     * then a registration tail. The whole thing is meant to run inside the
     * `(function(Scratch){ ... })(Scratch)` wrapper that _bakeProjectExtensions
     * adds, so it reads `Scratch` from that argument — exactly like this file.
     */
    _getRunningExtensionSource() {
      try {
        const classSource = MobileEventsExtension.toString();
        // Guard: a heavily minified/renamed class name would break the tail.
        if (!/class\s+MobileEventsExtension\b/.test(classSource)) {
          return null;
        }

        // Re-derive the runtime-configurable constants from their live values
        // so forks/overrides (window.MOBILE_*_URL) are preserved in the build.
        const parts = [];
        parts.push("'use strict';");
        parts.push(
          'const { runtime, ArgumentType, BlockType, TargetType, Cast } = Scratch;'
        );
        parts.push(`const EXTENSION_ID = ${JSON.stringify(EXTENSION_ID)};`);
        parts.push(
          `const EXTENSION_VERSION = ${JSON.stringify(EXTENSION_VERSION)};`
        );
        parts.push(`const SELF_URL = ${JSON.stringify(SELF_URL)};`);
        parts.push(`const SCAFFOLDING_URL = ${JSON.stringify(SCAFFOLDING_URL)};`);
        parts.push(`const APP_INVENTOR_URL = ${JSON.stringify(APP_INVENTOR_URL)};`);
        parts.push(`const JSZIP_URL = ${JSON.stringify(JSZIP_URL)};`);
        parts.push(
          `const VIEWPORT_PRESETS = ${JSON.stringify(VIEWPORT_PRESETS)};`
        );

        // Module-level helper functions, serialized from the live functions.
        parts.push(`const clamp = ${clamp.toString()};`);
        parts.push(`const round2 = ${round2.toString()};`);
        parts.push(`${clientToStage.toString()}`);

        // The extension class itself, verbatim from the running code.
        parts.push(classSource);

        // Registration tail (mirrors the bottom of this file).
        parts.push(
          'const extensionInstance = new MobileEventsExtension(runtime);'
        );
        parts.push('Scratch.extensions.register(extensionInstance);');

        return parts.join('\n');
      } catch (e) {
        console.warn(
          '[Mobile Events] failed to serialize running extension source:',
          e
        );
        return null;
      }
    }

    // ----------------------------------------------------------------
    //  Build: assemble the standalone HTML app
    //
    //  The output is a single HTML file that inlines both the Scratch runtime
    //  and the base64-encoded project, so it runs offline anywhere — including
    //  inside a mobile WebView.
    // ----------------------------------------------------------------

    async _generateHtmlApp() {
      const cfg = this.appConfig;
      const slim = !!cfg.slimBuild;

      // In slim mode we DON'T download/inline the ~4 MB runtime; we reference
      // it from the CDN via <script src> instead. Only fetch what we need.
      const tasks = [this._exportProjectSb3(), this._bakeProjectExtensions()];
      if (!slim) {
        tasks.push(this._loadScaffoldingSource());
      }
      const results = await Promise.all(tasks);
      const projectData = results[0];
      const extensionURIs = results[1];
      const scaffoldingSource = slim ? null : results[2];

      const projectBase64 = this._uint8ToBase64(projectData);
      const escapedTitle = this._escapeHtml(cfg.name);

      // Runtime <script> tag: inline the source, or reference the CDN.
      const runtimeScriptTag = slim
        ? `<script src="${SCAFFOLDING_URL}"></script>`
        : `<script>${scaffoldingSource}</script>`;

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

  ${runtimeScriptTag}
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
      // Custom extensions used by the project (e.g. this Mobile Events
      // extension), baked as data: URIs so the packaged runtime can load them.
      var EXTENSION_URIS = ${JSON.stringify(extensionURIs)};

      // In slim builds the runtime is loaded from the CDN with <script src>,
      // which may not be ready when this bootstrap runs. Wait for it (with a
      // timeout) before starting. In inline builds it's already defined.
      function whenScaffoldingReady(cb) {
        if (typeof Scaffolding !== 'undefined' && Scaffolding.Scaffolding) {
          cb();
          return;
        }
        var waited = 0;
        var timer = setInterval(function () {
          if (typeof Scaffolding !== 'undefined' && Scaffolding.Scaffolding) {
            clearInterval(timer);
            cb();
          } else if ((waited += 50) >= 30000) {
            clearInterval(timer);
            showError(new Error(
              'Could not load the Scratch runtime from the network. ' +
              'A slim build needs an internet connection on first run.'
            ));
          }
        }, 50);
      }

      whenScaffoldingReady(function () {
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

        // Allow the packaged project's custom extensions to load, and register
        // them into the runtime BEFORE loading the project (otherwise the VM
        // rejects the project with "Permission to load extension denied").
        try {
          if (scaffolding.setExtensionSecurityManager) {
            scaffolding.setExtensionSecurityManager({
              getSandboxMode: function () { return 'unsandboxed'; },
              canLoadExtensionFromProject: function () { return true; },
              canFetch: function () { return true; },
              canOpenWindow: function () { return true; },
              canRedirect: function () { return true; }
            });
          }
        } catch (e) { /* older scaffolding without a security manager */ }

        var loadExtensions = Promise.resolve();
        if (vm.extensionManager && vm.extensionManager.loadExtensionURL) {
          loadExtensions = Promise.all(EXTENSION_URIS.map(function (uri) {
            return vm.extensionManager.loadExtensionURL(uri).catch(function (err) {
              console.warn('Could not load bundled extension', err);
            });
          }));
        }

        loadExtensions.then(function () {
          var zipData = base64ToUint8(PROJECT_BASE64);
          return scaffolding.loadProject(zipData);
        }).then(function () {
          loadingEl.style.display = 'none';
          if (SETTINGS.autoStart) {
            scaffolding.greenFlag();
          }
        }).catch(showError);
      } catch (e) {
        showError(e);
      }
      });
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

    // ----------------------------------------------------------------
    //  App Inventor — open the website so the user can embed the built HTML.
    //
    //  MIT App Inventor can take the standalone HTML this extension produces
    //  and embed it (e.g. via a WebViewer with HTML content), so there is no
    //  need to generate an .aia here. We just open App Inventor in a new tab.
    // ----------------------------------------------------------------

    openAppInventor() {
      try {
        if (typeof window !== 'undefined' && typeof window.open === 'function') {
          window.open(APP_INVENTOR_URL, '_blank', 'noopener');
        }
      } catch (e) {
        this._reportBuildError(e);
      }
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
    //  Utility: JSZip loader (fallback sb3 build), downloads, encoding
    // ----------------------------------------------------------------

    _loadJSZip() {
      if (typeof window !== 'undefined' && window.JSZip) {
        return Promise.resolve(window.JSZip);
      }
      // Reuse the VM's bundled JSZip if the host exposes it.
      try {
        if (
          typeof Scratch !== 'undefined' &&
          Scratch.vm &&
          Scratch.vm.exports &&
          Scratch.vm.exports.JSZip
        ) {
          return Promise.resolve(Scratch.vm.exports.JSZip);
        }
      } catch (e) { /* ignore */ }
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
  }

  // ------------------------------------------------------------------
  //  Register
  //
  //  Cocrea/Gandi requires this to run synchronously the moment the script
  //  executes. Construct the instance first, then register — and never let a
  //  stray error prevent the synchronous register() call from happening.
  // ------------------------------------------------------------------
  const extensionInstance = new MobileEventsExtension(runtime);
  Scratch.extensions.register(extensionInstance);
})(Scratch);
