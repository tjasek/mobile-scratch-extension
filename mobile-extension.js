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

  // URL of the TurboWarp packager used to wrap the project into a mobile app.
  // Forks can override this by setting window.MOBILE_PACKAGER_URL before load.
  const PACKAGER_URL =
    (typeof window !== 'undefined' && window.MOBILE_PACKAGER_URL) ||
    'https://packager.turbowarp.org/';

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
          // ─── Packager / build ────────────────────────────────
          '---Mobile App',
          {
            blockType: BlockType.BUTTON,
            text: '📱 Build mobile app',
            onClick: () => this.buildMobileApp(),
            func: 'buildMobileApp',
          },
          {
            opcode: 'openPackager',
            blockType: BlockType.COMMAND,
            text: 'open mobile app packager',
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
      const wanted = Cast.toString(args.DIRECTION);
      if (wanted === 'any' || wanted === '') return true;
      return wanted === this.lastScrollDirection;
    }

    // The remaining event hats have no argument and always run when started.
    whenTouched() {
      return true;
    }

    whenTouchMoved() {
      return true;
    }

    whenTouchReleased() {
      return true;
    }

    whenPortrait() {
      return true;
    }

    whenLandscape() {
      return true;
    }

    whenOrientationChanged() {
      return true;
    }

    whenTilted() {
      return true;
    }

    whenShaken() {
      return true;
    }

    // ----------------------------------------------------------------
    //  Touch reporters
    // ----------------------------------------------------------------

    isTouchingScreen() {
      return this.isTouching;
    }

    getTouchX() {
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
      return Cast.toString(args.MODE) === this.orientationMode;
    }

    getOrientation() {
      return this.orientationMode;
    }

    // ----------------------------------------------------------------
    //  Device sensor reporters
    // ----------------------------------------------------------------

    getTilt(args) {
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
    //  Packager integration
    // ----------------------------------------------------------------

    openPackager() {
      this._openPackagerWindow();
    }

    buildMobileApp() {
      this._openPackagerWindow();
    }

    _openPackagerWindow() {
      const projectId = this._getProjectId();
      let url = PACKAGER_URL;
      if (projectId) {
        // The TurboWarp packager accepts a project id via the URL hash so the
        // project loads automatically, ready to be exported as a mobile app.
        url = `${PACKAGER_URL}#${projectId}`;
      }
      if (typeof window !== 'undefined' && window.open) {
        window.open(url, '_blank', 'noopener');
      }
    }

    _getProjectId() {
      // Try a few well-known locations for the current project id.
      try {
        if (this.runtime && this.runtime.gandi && this.runtime.gandi.projectId) {
          return this.runtime.gandi.projectId;
        }
      } catch (e) {
        /* ignore */
      }
      try {
        const match = String(window.location.href).match(/(\d{6,})/);
        if (match) return match[1];
      } catch (e) {
        /* ignore */
      }
      return null;
    }
  }

  // ------------------------------------------------------------------
  //  Register
  // ------------------------------------------------------------------
  Scratch.extensions.register(new MobileEventsExtension(runtime));
})(Scratch);
