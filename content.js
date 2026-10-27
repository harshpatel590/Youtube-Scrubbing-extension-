(() => {
  const CONTENT_VERSION = '3.0';

  if (window.__mxScrubberVersion === CONTENT_VERSION) return;

  if (typeof window.__mxScrubberCleanup === 'function') {
    try { window.__mxScrubberCleanup(); } catch (_) {}
  }

  window.__mxScrubberVersion = CONTENT_VERSION;
  window.__mxScrubberLoaded = true;

  
  /* ------------------------------------------------------------------ *
   * FIX 2a — kill Chrome's two-finger swipe-back gesture
   * overscroll-behavior-x: none stops horizontal overscroll from being
   * translated into history navigation.
   * ------------------------------------------------------------------ */
  try {
    const style = document.createElement('style');
    style.id = '__mx-scrubber-overscroll';
    style.textContent = 'html { overscroll-behavior-x: none !important; }';
    (document.head || document.documentElement).appendChild(style);
  } catch (_) {}

  /* ------------------------------------------------------------------ *
   * FIX 2b — listener bookkeeping so a re-injection can clean up
   * ------------------------------------------------------------------ */
  const cleanups = [];
  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  }
  window.__mxScrubberCleanup = () => {
    for (const fn of cleanups) { try { fn(); } catch (_) {} }
    cleanups.length = 0;
    try { document.getElementById('__mx-scrubber-overscroll')?.remove(); } catch (_) {}
  };

  /* ------------------------------------------------------------------ *
   * CONFIG + PROFILES
   * ------------------------------------------------------------------ */
  const MOUSE_DEFAULTS = {
    requireHover: true,
    activationThreshold: 140,
    activationWindowMs: 400,
    settleDelayMs: 350,
    ytPixelsPerDelta: 0.35,
    fallbackSecondsPerTick: 1.5,
    invertDirection: true,
    autoPlayAfterScrub: true,
    dynamicScrubSpeed: true,
    minSpeedMultiplier: 0.12,
    maxSpeedMultiplier: 2.5,
    slowSpeed: 0.4,
    fastSpeed: 2.5,
    speedSmoothing: 0.3,
    speedResetMs: 250
  };

  const TRACKPAD_DEFAULTS = {
    requireHover: true,
    activationThreshold: 220,
    activationWindowMs: 600,
    settleDelayMs: 550,
    ytPixelsPerDelta: 0.10,
    fallbackSecondsPerTick: 0.5,
    invertDirection: false,
    autoPlayAfterScrub: true,
    dynamicScrubSpeed: true,
    minSpeedMultiplier: 0.05,
    maxSpeedMultiplier: 1.2,
    slowSpeed: 0.8,
    fastSpeed: 6.0,
    speedSmoothing: 0.15,
    speedResetMs: 120
  };

  const CONFIG = { ...MOUSE_DEFAULTS };
  let activeProfile = 'mouse';
  const profiles = {
    mouse: { ...MOUSE_DEFAULTS },
    trackpad: { ...TRACKPAD_DEFAULTS }
  };

  function applyProfile() {
    Object.assign(CONFIG, profiles[activeProfile] || MOUSE_DEFAULTS);
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(['activeProfile', 'profiles'], (stored) => {
      if (!stored) return;
      if (stored.activeProfile === 'mouse' || stored.activeProfile === 'trackpad') {
        activeProfile = stored.activeProfile;
      }
      if (stored.profiles) {
        if (stored.profiles.mouse) Object.assign(profiles.mouse, stored.profiles.mouse);
        if (stored.profiles.trackpad) Object.assign(profiles.trackpad, stored.profiles.trackpad);
      }
      applyProfile();
      console.info('[MX Scrubber] v' + CONTENT_VERSION,
        'profile:', activeProfile, 'config:', CONFIG);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.activeProfile) {
        const v = changes.activeProfile.newValue;
        if (v === 'mouse' || v === 'trackpad') activeProfile = v;
      }
      if (changes.profiles && changes.profiles.newValue) {
        const np = changes.profiles.newValue;
        if (np.mouse) Object.assign(profiles.mouse, np.mouse);
        if (np.trackpad) Object.assign(profiles.trackpad, np.trackpad);
      }
      applyProfile();
    });
  }

  /* ------------------------------------------------------------------ *
   * STATE
   * ------------------------------------------------------------------ */
  const scrubState = {
    active: false,
    preScrubAccumulator: 0,
    preScrubResetTimer: null,
    mode: null,
    video: null,
    wasPlaying: false,
    startTime: 0,
    targetTime: 0,
    virtualX: 0,
    barRect: null,
    barElement: null,
    settleTimer: null,
    lastWheelTime: 0,
    smoothedSpeed: 0
  };

  let hudElement = null;
  let hudHideTimer = null;

  /* ------------------------------------------------------------------ *
   * POINTER FREEZE — swallow trusted pointer moves during a scrub
   * ------------------------------------------------------------------ */
  const BLOCKED_POINTER_EVENTS = ['mousemove', 'pointermove', 'pointerrawupdate'];

  function onBlockedPointerEvent(event) {
    if (!scrubState.active) return;
    if (!event.isTrusted) return;
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  for (const type of BLOCKED_POINTER_EVENTS) {
    on(window, type, onBlockedPointerEvent, { capture: true, passive: true });
    on(document, type, onBlockedPointerEvent, { capture: true, passive: true });
  }

  /* ------------------------------------------------------------------ *
   * DYNAMIC SPEED
   * ------------------------------------------------------------------ */
  function updateScrollSpeed(deltaX, now) {
    const rawDt = scrubState.lastWheelTime > 0
      ? now - scrubState.lastWheelTime
      : CONFIG.speedResetMs;
    const dt = Math.max(rawDt, 1);
    scrubState.lastWheelTime = now;

    const instantSpeed = Math.abs(deltaX) / Math.min(dt, 16);

    if (scrubState.smoothedSpeed === 0 || rawDt > CONFIG.speedResetMs) {
      scrubState.smoothedSpeed = instantSpeed;
    } else {
      scrubState.smoothedSpeed +=
        (instantSpeed - scrubState.smoothedSpeed) * CONFIG.speedSmoothing;
    }
  }

  function getSpeedMultiplier() {
    if (!CONFIG.dynamicScrubSpeed) return 1;

    const slow = CONFIG.slowSpeed;
    const fast = CONFIG.fastSpeed;
    const minM = CONFIG.minSpeedMultiplier;
    const maxM = CONFIG.maxSpeedMultiplier;

    const speed = Math.min(Math.max(scrubState.smoothedSpeed, slow), fast);
    let t = (Math.log(speed) - Math.log(slow)) / (Math.log(fast) - Math.log(slow));
    t = Math.min(Math.max(t, 0), 1);
    t = t * t * (3 - 2 * t);
    return minM * Math.pow(maxM / minM, t);
  }

  /* ------------------------------------------------------------------ *
   * VIDEO RESOLUTION
   * ------------------------------------------------------------------ */
  function getTargetVideo(mouseX, mouseY) {
    const videos = Array.from(document.querySelectorAll('video')).filter(
      (v) => v.readyState > 0 && v.duration > 0 && v.offsetWidth > 0
    );
    if (videos.length === 0) return null;

    for (const video of videos) {
      const rect = video.getBoundingClientRect();
      if (mouseX >= rect.left && mouseX <= rect.right &&
          mouseY >= rect.top && mouseY <= rect.bottom) {
        return video;
      }
    }

    if (CONFIG.requireHover) return null;

    const playing = videos.find((v) => !v.paused);
    if (playing) return playing;

    return videos.reduce((a, b) => {
      const aR = a.getBoundingClientRect();
      const bR = b.getBoundingClientRect();
      return bR.width * bR.height > aR.width * aR.height ? b : a;
    });
  }

  function isInsideHorizontallyScrollableElement(el) {
    while (el && el !== document.body && el !== document.documentElement) {
      const style = window.getComputedStyle(el);
      if ((style.overflowX === 'auto' || style.overflowX === 'scroll') &&
          el.scrollWidth > el.clientWidth) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function dispatchMouseEvent(target, type, clientX, clientY) {
    const evt = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: clientX,
      clientY: clientY,
      buttons: type === 'mouseup' ? 0 : 1
    });
    target.dispatchEvent(evt);
  }

  function formatTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return hrs > 0
      ? `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function updateHUD(video, previewTime, startTime, isDragging) {
    if (!hudElement) {
      hudElement = document.createElement('div');
      Object.assign(hudElement.style, {
        position: 'fixed',
        zIndex: '2147483647',
        background: 'rgba(12, 12, 14, 0.88)',
        color: '#ffffff',
        padding: '8px 14px',
        borderRadius: '8px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '13px',
        fontWeight: '600',
        pointerEvents: 'none',
        transition: 'opacity 0.15s ease',
        boxShadow: '0 4px 16px rgba(0,0,0,0.45)',
        backdropFilter: 'blur(6px)',
        border: '1px solid rgba(255,255,255,0.12)'
      });
      document.body.appendChild(hudElement);
    }

    const diff = previewTime - startTime;
    const sign = diff >= 0 ? '+' : '';
    const statusIcon = isDragging ? '⏸ PREVIEW' : '▶ PLAYING';
    hudElement.textContent = `${statusIcon}  •  ${formatTime(previewTime)} / ${formatTime(video.duration)} (${sign}${diff.toFixed(1)}s)`;

    const rect = video.getBoundingClientRect();
    hudElement.style.left = `${rect.left + rect.width / 2 - hudElement.offsetWidth / 2}px`;
    hudElement.style.top = `${rect.top + 24}px`;
    hudElement.style.opacity = '1';

    clearTimeout(hudHideTimer);
    if (!isDragging) {
      hudHideTimer = setTimeout(() => {
        if (hudElement) hudElement.style.opacity = '0';
      }, 650);
    }
  }

  function beginScrubSession(video) {
    scrubState.active = true;
    scrubState.preScrubAccumulator = 0;
    clearTimeout(scrubState.preScrubResetTimer);

    scrubState.video = video;
    scrubState.wasPlaying = !video.paused;
    scrubState.startTime = video.currentTime;
    scrubState.targetTime = video.currentTime;

    const ytBar = document.querySelector('.ytp-progress-bar');
    const ytPlayer = document.querySelector('.html5-video-player');

    if (ytBar && ytPlayer && ytPlayer.contains(video)) {
      ytPlayer.classList.remove('ytp-autohide');
      dispatchMouseEvent(video, 'mousemove', 100, 100);

      const barRect = ytBar.getBoundingClientRect();
      if (barRect.width > 50) {
        scrubState.mode = 'youtube';
        scrubState.barElement = ytBar;
        scrubState.barRect = barRect;

        const progressRatio = Math.min(Math.max(video.currentTime / video.duration, 0), 1);
        scrubState.virtualX = barRect.left + progressRatio * barRect.width;
        const centerY = barRect.top + barRect.height / 2;

        video.pause();
        dispatchMouseEvent(ytBar, 'mouseenter', scrubState.virtualX, centerY);
        dispatchMouseEvent(ytBar, 'mousedown', scrubState.virtualX, centerY);
        return;
      }
    }

    scrubState.mode = 'html5';
    video.pause();
  }

  function updateScrubSession(deltaX, speedMultiplier) {
    const { video, mode, barRect } = scrubState;
    if (!video) return;

    if (mode === 'youtube' && barRect) {
      const liveRect = scrubState.barElement.getBoundingClientRect();
      if (liveRect.width > 50) scrubState.barRect = liveRect;

      const r = scrubState.barRect;
      const centerY = r.top + r.height / 2;

      scrubState.virtualX = Math.min(
        Math.max(r.left, scrubState.virtualX + deltaX * CONFIG.ytPixelsPerDelta * speedMultiplier),
        r.right
      );

      const ratio = (scrubState.virtualX - r.left) / r.width;
      scrubState.targetTime = ratio * video.duration;

      dispatchMouseEvent(document, 'mousemove', scrubState.virtualX, centerY);
      updateHUD(video, scrubState.targetTime, scrubState.startTime, true);
    } else {
      const intensity = Math.min(Math.max(Math.abs(deltaX) / 20, 0.25), 6);
      const stepSeconds =
        (deltaX > 0 ? 1 : -1) * CONFIG.fallbackSecondsPerTick * intensity * speedMultiplier;

      scrubState.targetTime = Math.min(Math.max(0, scrubState.targetTime + stepSeconds), video.duration);

      if (typeof video.fastSeek === 'function') {
        video.fastSeek(scrubState.targetTime);
      } else {
        video.currentTime = scrubState.targetTime;
      }

      updateHUD(video, scrubState.targetTime, scrubState.startTime, true);
    }
  }

  function finishScrubSession() {
    if (!scrubState.active) return;

    const { video, mode, barElement, barRect, virtualX, targetTime, startTime, wasPlaying } = scrubState;

    if (mode === 'youtube' && barElement && barRect) {
      const centerY = barRect.top + barRect.height / 2;
      dispatchMouseEvent(document, 'mouseup', virtualX, centerY);
      dispatchMouseEvent(barElement, 'mouseleave', virtualX, centerY);
    } else if (video) {
      video.currentTime = targetTime;
    }

    if (video && (CONFIG.autoPlayAfterScrub || wasPlaying)) {
      video.play().catch(() => {});
    }

    if (video) {
      updateHUD(video, targetTime, startTime, false);
    }

    scrubState.active = false;
    scrubState.preScrubAccumulator = 0;
    scrubState.video = null;
    scrubState.barElement = null;
  }

  /* ------------------------------------------------------------------ *
   * WHEEL HANDLER
   * ------------------------------------------------------------------ */
  
  on(window, 'wheel', (event) => {
    if (isPanelOpen()) return;
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || Math.abs(event.deltaX) < 0.5) {
      return;
    }

    const activeTag = document.activeElement?.tagName;
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || document.activeElement?.isContentEditable) {
      return;
    }

    const video = scrubState.active ? scrubState.video : getTargetVideo(event.clientX, event.clientY);
    if (!video) return;

    if (!scrubState.active) {
      const vRect = video.getBoundingClientRect();
      const hoveringVideo =
        event.clientX >= vRect.left &&
        event.clientX <= vRect.right &&
        event.clientY >= vRect.top &&
        event.clientY <= vRect.bottom;

      if (!hoveringVideo && isInsideHorizontallyScrollableElement(event.target)) {
        return;
      }
    }

    event.preventDefault();
    event.stopPropagation();

    const effectiveDeltaX = event.deltaX * (CONFIG.invertDirection ? -1 : 1);

    updateScrollSpeed(effectiveDeltaX, performance.now());
    const speedMultiplier = getSpeedMultiplier();

    if (!scrubState.active) {
      scrubState.preScrubAccumulator += Math.abs(effectiveDeltaX);

      clearTimeout(scrubState.preScrubResetTimer);
      scrubState.preScrubResetTimer = setTimeout(() => {
        scrubState.preScrubAccumulator = 0;
      }, CONFIG.activationWindowMs);

      if (scrubState.preScrubAccumulator < CONFIG.activationThreshold) {
        return;
      }

      beginScrubSession(video);
    }

    updateScrubSession(effectiveDeltaX, speedMultiplier);

    clearTimeout(scrubState.settleTimer);
    scrubState.settleTimer = setTimeout(finishScrubSession, CONFIG.settleDelayMs);
  }, { passive: false, capture: true });
    /* ================================================================== *
   * IN-PAGE GLASS SETTINGS PANEL
   * ================================================================== */
  const PANEL_DEFAULTS = {
    mouse: { ...MOUSE_DEFAULTS },
    trackpad: { ...TRACKPAD_DEFAULTS }
  };

    const PANEL_SCHEMA = [
    { title: 'Activation', fields: [
      { key: 'requireHover', label: 'Require hover over video', type: 'bool', 
        help: 'Only scrub when your cursor is physically over the video. Turn off to scrub from anywhere.' },
      { key: 'activationThreshold', label: 'Activation threshold', type: 'range', min: 20, max: 500, step: 10, unit: 'px', 
        help: 'How far you must scroll to unlock scrubbing. Prevents accidental triggers.' },
      { key: 'activationWindowMs', label: 'Activation window', type: 'range', min: 100, max: 2000, step: 50, unit: 'ms', 
        help: 'Time window to reach the threshold. If you scroll too slowly, it resets.' }
    ]},
    { title: 'Direction & Playback', fields: [
      { key: 'invertDirection', label: 'Invert scroll direction', type: 'bool', 
        help: 'Flip this if scrolling right moves the video backwards.' },
      { key: 'autoPlayAfterScrub', label: 'Always play after scrub', type: 'bool', 
        help: 'Automatically resumes playing the video after you stop scrolling.' },
      { key: 'settleDelayMs', label: 'Settle delay', type: 'range', min: 0, max: 2000, step: 50, unit: 'ms', 
        help: 'How long to wait after you stop scrolling before playback resumes.' }
    ]},
    { title: 'Sensitivity', fields: [
      { key: 'ytPixelsPerDelta', label: 'YouTube scrub sensitivity', type: 'range', min: 0.05, max: 2, step: 0.01, 
        help: 'How far the timeline moves per scroll unit on YouTube.' },
      { key: 'fallbackSecondsPerTick', label: 'Fallback seconds per tick', type: 'range', min: 0.1, max: 5, step: 0.1, unit: 's', 
        help: 'Base step size on non-YouTube sites (Vimeo, Netflix, etc).' }
    ]},
    { title: 'Dynamic Speed', fields: [
      { key: 'dynamicScrubSpeed', label: 'Enable dynamic speed', type: 'bool', 
        help: 'Scroll slowly for fine-tuning, scroll fast to jump further.' },
      { key: 'minSpeedMultiplier', label: 'Min multiplier', type: 'range', min: 0.01, max: 1, step: 0.01, unit: '×', 
        help: 'The slowest/finest speed when you scroll gently.' },
      { key: 'maxSpeedMultiplier', label: 'Max multiplier', type: 'range', min: 0.5, max: 5, step: 0.1, unit: '×', 
        help: 'The fastest jump speed. Lower this if fast scrubs feel too aggressive.' },
      { key: 'slowSpeed', label: 'Slow speed threshold', type: 'range', min: 0.1, max: 10, step: 0.1, unit: 'px/ms', 
        help: 'The scroll speed (pixels per ms) considered "slow".' },
      { key: 'fastSpeed', label: 'Fast speed threshold', type: 'range', min: 0.5, max: 15, step: 0.1, unit: 'px/ms', 
        help: 'The scroll speed considered "fast". Raise to require a harder swipe to hit max speed.' },
      { key: 'speedSmoothing', label: 'Smoothing', type: 'range', min: 0.05, max: 1, step: 0.01, 
        help: 'Higher = snappier speed changes. Lower = smoother, more gradual changes.' },
      { key: 'speedResetMs', label: 'Speed reset window', type: 'range', min: 50, max: 1000, step: 10, unit: 'ms', 
        help: 'How long you pause before it forgets your previous scroll speed.' }
    ]}
  ];

  let panelHost = null;
  let panelCleanup = null;

  function isPanelOpen() { return panelHost !== null; }

  function toggleSettingsPanel() {
    if (panelHost) { closeSettingsPanel(); } else { createSettingsPanel(); }
  }

  function closeSettingsPanel() {
    if (panelCleanup) { try { panelCleanup(); } catch (_) {} panelCleanup = null; }
    if (panelHost) { try { panelHost.remove(); } catch (_) {} panelHost = null; }
  }

  function formatPanelValue(field, v) {
    return Number(field.step) < 1 ? Number(v).toFixed(2) : v;
  }

  function createSettingsPanel() {
    panelHost = document.createElement('div');
    panelHost.id = '__mx-settings-host';
    panelHost.style.cssText =
      'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: auto;';

    const shadow = panelHost.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(panelHost);

    shadow.innerHTML = `
            <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0; }

        .backdrop {
          position: fixed; inset: 0;
          background: transparent;
          pointer-events: auto;
        }

        .panel {
          position: fixed;
          top: 20px; right: 20px;
          width: 310px; /* Reduced from 380px */
          max-height: calc(100vh - 40px);
          display: flex;
          flex-direction: column;
          border-radius: 20px;
          overflow: hidden;
          color: #ffffff;
          font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
          font-size: 12px;
          
          /* Darker glass for better text visibility */
          background: linear-gradient(145deg,
            rgba(20, 20, 25, 0.85) 0%,
            rgba(10, 10, 15, 0.92) 100%);
            
          /* brightness(0.6) darkens the background behind the glass */
          backdrop-filter: blur(20px) saturate(150%) brightness(0.6);
          -webkit-backdrop-filter: blur(20px) saturate(150%) brightness(0.6);
          
          border: 1px solid rgba(255,255,255,0.15);
          box-shadow:
            0 24px 60px rgba(0,0,0,0.6),
            inset 0 1px 0 rgba(255,255,255,0.2);
          animation: panelIn 0.4s cubic-bezier(0.22, 1, 0.36, 1);
        }

        @keyframes panelIn {
          from { opacity: 0; transform: translateY(-12px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }

        header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 14px;
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        .brand { display: flex; align-items: center; gap: 10px; }
        .logo {
          width: 28px; height: 28px; flex-shrink: 0;
          display: grid; place-items: center;
          border-radius: 8px;
          background: linear-gradient(135deg, #5fb8ff, #8b5cf6);
          box-shadow: 0 2px 12px rgba(95,184,255,0.4);
        }
        .logo svg { width: 14px; height: 14px; }
        h1 { font-size: 12px; font-weight: 700; letter-spacing: 0.2px; }
        .subtitle { font-size: 9px; opacity: 0.6; margin-top: 1px; }
        
        .close {
          width: 24px; height: 24px;
          display: grid; place-items: center;
          border: none; border-radius: 6px;
          background: rgba(255,255,255,0.1);
          color: #fff; font-size: 16px; line-height: 1;
          cursor: pointer;
          transition: background 0.15s ease, transform 0.15s ease;
        }
        .close:hover { background: rgba(255,255,255,0.2); }
        .close:active { transform: scale(0.92); }

        .body {
          overflow-y: auto;
          padding: 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          scrollbar-width: thin;
          scrollbar-color: rgba(255,255,255,0.2) transparent;
          /* Limits the height so it doesn't cover the whole screen */
          max-height: 450px; 
        }
        .body::-webkit-scrollbar { width: 6px; }
        .body::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.2);
          border-radius: 3px;
        }

        .mode-switch {
          position: relative;
          display: grid;
          grid-template-columns: 1fr 1fr;
          padding: 3px;
          border-radius: 10px;
          background: rgba(0,0,0,0.4);
          border: 1px solid rgba(255,255,255,0.08);
        }
        .mode-slider {
          position: absolute;
          top: 3px; left: 3px;
          width: calc(50% - 3px);
          height: calc(100% - 6px);
          border-radius: 7px;
          background: linear-gradient(135deg, #5fb8ff, #8b5cf6);
          box-shadow: 0 2px 8px rgba(95,184,255,0.4);
          transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
          z-index: 0;
        }
        .mode-switch[data-active="mouse"] .mode-slider {
          transform: translateX(100%);
        }
        .mode-btn {
          position: relative; z-index: 1;
          padding: 6px;
          background: transparent; border: none;
          color: rgba(255,255,255,0.6);
          font: inherit; font-weight: 600; font-size: 10.5px;
          cursor: pointer; border-radius: 7px;
          transition: color 0.2s ease;
        }
        .mode-btn.active { color: #fff; }

        .section {
          padding: 10px 12px;
          border-radius: 12px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.06);
        }
        .section h2 {
          font-size: 9px;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          opacity: 0.7;
          font-weight: 700;
          margin-bottom: 10px;
          display: flex; align-items: center; gap: 6px;
        }
        .section h2::before {
          content: '';
          width: 3px; height: 10px;
          border-radius: 2px;
          background: linear-gradient(180deg, #5fb8ff, #8b5cf6);
        }

        .field { margin-bottom: 12px; }
        .field:last-child { margin-bottom: 0; }
        .field-header {
          display: flex; justify-content: space-between;
          align-items: center; margin-bottom: 6px;
          font-weight: 500; font-size: 11.5px;
        }
                /* --- Tooltip Styles --- */
        .label-group {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .tooltip-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: rgba(255,255,255,0.15);
          color: rgba(255,255,255,0.7);
          font-size: 9px;
          font-weight: bold;
          cursor: help;
          position: relative;
          transition: background 0.2s ease;
        }

        .tooltip-icon:hover {
          background: rgba(255,255,255,0.3);
          color: #fff;
        }

                /* --- Floating Tooltip --- */
        .mx-tooltip {
          position: fixed;
          top: 0; left: 0;
          background: rgba(15, 15, 20, 0.95);
          border: 1px solid rgba(255,255,255,0.2);
          color: #fff;
          padding: 8px 12px;
          border-radius: 8px;
          font-size: 11px;
          line-height: 1.4;
          width: max-content;
          max-width: 200px;
          z-index: 2147483647; /* Stay on top of everything */
          pointer-events: none;
          opacity: 0;
          visibility: hidden;
          transition: opacity 0.15s ease, visibility 0.15s ease;
          box-shadow: 0 4px 16px rgba(0,0,0,0.6);
          text-shadow: none;
          box-sizing: border-box;
        }

        .tooltip-icon:hover .tooltip-text {
          visibility: visible;
          opacity: 1;
        }
        .value {
          font-variant-numeric: tabular-nums;
          font-weight: 700; font-size: 10px;
          background: rgba(95,184,255,0.15);
          border: 1px solid rgba(95,184,255,0.25);
          color: #cfe6ff;
          padding: 1px 6px; border-radius: 5px;
          min-width: 34px; text-align: center;
        }

        input[type="range"] {
          width: 100%; height: 4px;
          -webkit-appearance: none; appearance: none;
          border-radius: 2px; outline: none; cursor: pointer;
          background: linear-gradient(to right,
            #5fb8ff 0%, #8b5cf6 var(--fill, 0%),
            rgba(255,255,255,0.15) var(--fill, 0%),
            rgba(255,255,255,0.15) 100%);
        }
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          width: 12px; height: 12px; border-radius: 50%;
          background: #ffffff;
          border: none;
          box-shadow: 0 0 0 2px rgba(95,184,255,0.5), 0 1px 4px rgba(0,0,0,0.5);
          cursor: pointer;
          transition: transform 0.15s ease;
        }
        input[type="range"]:hover::-webkit-slider-thumb {
          transform: scale(1.2);
        }

        .toggle {
          display: flex; align-items: center;
          justify-content: space-between;
          gap: 12px; cursor: pointer; user-select: none;
          font-weight: 500; font-size: 11.5px;
        }
        .toggle input { display: none; }
        .toggle-track {
          position: relative; flex-shrink: 0;
          width: 32px; height: 18px;
          border-radius: 9px;
          background: rgba(255,255,255,0.15);
          border: 1px solid rgba(255,255,255,0.1);
          transition: background 0.3s ease, border-color 0.3s ease;
        }
        .toggle-track::after {
          content: '';
          position: absolute; top: 50%; left: 2px;
          width: 12px; height: 12px;
          transform: translateY(-50%);
          border-radius: 50%;
          background: #ffffff;
          box-shadow: 0 1px 4px rgba(0,0,0,0.4);
          transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .toggle input:checked + .toggle-track {
          background: linear-gradient(135deg, #5fb8ff, #8b5cf6);
          border-color: transparent;
        }
        .toggle input:checked + .toggle-track::after {
          transform: translate(14px, -50%);
        }

        footer {
          padding: 10px;
          border-top: 1px solid rgba(255,255,255,0.08);
        }
        .reset {
          width: 100%; padding: 8px;
          border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.05);
          color: #fff; font: inherit; font-weight: 600; font-size: 11px;
          cursor: pointer; transition: background 0.15s ease;
        }
        .reset:hover { background: rgba(255,255,255,0.12); }
        .reset:active { transform: scale(0.98); }

        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after {
            animation-duration: 0.001ms !important;
            transition-duration: 0.001ms !important;
          }
        }
      </style>

      <div class="backdrop"></div>
      <div class="panel" role="dialog" aria-label="MX Scrubber Settings">
        <header>
          <div class="brand">
            <div class="logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6"/>
              </svg>
            </div>
            <div>
              <h1>MX Scrubber</h1>
              <p class="subtitle">Horizontal video scrubbing</p>
            </div>
          </div>
          <button class="close" aria-label="Close">×</button>
        </header>

        <div class="body">
          <div class="mode-switch" data-active="mouse">
            <div class="mode-slider"></div>
            <button class="mode-btn" data-mode="trackpad">Trackpad</button>
            <button class="mode-btn" data-mode="mouse">Mouse wheel</button>
          </div>
          <div class="sections"></div>
        </div>

        <footer>
          <button class="reset">Reset all modes</button>
        </footer>
      </div>
    `;

    const $ = (s) => shadow.querySelector(s);
    const $$ = (s) => shadow.querySelectorAll(s);
    const $sections = $('.sections');
    const $modeSwitch = $('.mode-switch');
    const $backdrop = $('.backdrop');
    const $closeBtn = $('.close');
    const $resetBtn = $('.reset');
        // --- Tooltip Logic ---
    const $tooltip = document.createElement('div');
    $tooltip.className = 'mx-tooltip';
    shadow.appendChild($tooltip);

    function showTooltip(text, targetRect) {
      $tooltip.textContent = text;
      $tooltip.style.opacity = '1';
      $tooltip.style.visibility = 'visible';
      
      // Wait a frame so the tooltip calculates its new width
      requestAnimationFrame(() => {
        const tooltipRect = $tooltip.getBoundingClientRect();
        let top = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2);
        let left = targetRect.left - tooltipRect.width - 12; // 12px gap
        
        // If it goes off the left edge of the screen, flip it to the right
        if (left < 10) {
          left = targetRect.right + 12;
        }
        
        // Keep it from going off the top or bottom of the screen
        top = Math.max(10, Math.min(top, window.innerHeight - tooltipRect.height - 10));
        left = Math.max(10, Math.min(left, window.innerWidth - tooltipRect.width - 10));
        
        $tooltip.style.top = `${top}px`;
        $tooltip.style.left = `${left}px`;
      });
    }

    function hideTooltip() {
      $tooltip.style.opacity = '0';
      $tooltip.style.visibility = 'hidden';
    }
    // --------------------
    const panelState = {
      activeProfile: activeProfile,
      profiles: {
        mouse: { ...profiles.mouse },
        trackpad: { ...profiles.trackpad }
      }
    };

    const saveTimer = { t: null };
    function values() { return panelState.profiles[panelState.activeProfile]; }
    function label(m) { return m === 'mouse' ? 'Mouse wheel' : 'Trackpad'; }

    function setFill(input, field) {
      const v = parseFloat(input.value);
      const pct = ((v - field.min) / (field.max - field.min)) * 100;
      input.style.setProperty('--fill', `${pct}%`);
    }

    function persist() {
      clearTimeout(saveTimer.t);
      saveTimer.t = setTimeout(() => {
        chrome.storage.sync.set({
          profiles: panelState.profiles,
          activeProfile: panelState.activeProfile
        });
      }, 100);
    }

        function buildField(field) {
      const wrap = document.createElement('div');
      wrap.className = 'field';

      // 1. Build the label group safely
      const labelGroup = document.createElement('div');
      labelGroup.className = 'label-group';
      
      const labelText = document.createElement('span');
      labelText.textContent = field.label;
      labelGroup.appendChild(labelText);

      if (field.help) {
        const icon = document.createElement('div');
        icon.className = 'tooltip-icon';
        icon.textContent = '?';
        icon.addEventListener('mouseenter', (e) => {
          showTooltip(field.help, e.target.getBoundingClientRect());
        });
        icon.addEventListener('mouseleave', hideTooltip);
        labelGroup.appendChild(icon);
      }

      // 2. Build the input (checkbox or range)
      if (field.type === 'bool') {
        const l = document.createElement('label');
        l.className = 'toggle';
        l.appendChild(labelGroup);
        
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!values()[field.key];
        input.addEventListener('change', () => {
          values()[field.key] = input.checked;
          persist();
        });
        
        const track = document.createElement('span');
        track.className = 'toggle-track';
        
        l.appendChild(input);
        l.appendChild(track);
        wrap.appendChild(l);
        return wrap;
      }

      const header = document.createElement('div');
      header.className = 'field-header';
      header.appendChild(labelGroup);
      
      const valSpan = document.createElement('span');
      valSpan.className = 'value';
      valSpan.textContent =
        formatPanelValue(field, values()[field.key]) + (field.unit ? ' ' + field.unit : '');
      header.appendChild(valSpan);
      wrap.appendChild(header);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = field.min;
      input.max = field.max;
      input.step = field.step;
      input.value = values()[field.key];
      setFill(input, field);
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        valSpan.textContent =
          formatPanelValue(field, v) + (field.unit ? ' ' + field.unit : '');
        setFill(input, field);
        values()[field.key] = v;
        persist();
      });
      wrap.appendChild(input);
      return wrap;
    }

    function buildUI() {
      $sections.innerHTML = '';
      PANEL_SCHEMA.forEach((section) => {
        const el = document.createElement('section');
        el.className = 'section';
        const h2 = document.createElement('h2');
        h2.textContent = section.title;
        el.appendChild(h2);
        for (const f of section.fields) el.appendChild(buildField(f));
        $sections.appendChild(el);
      });
      $modeSwitch.dataset.active = panelState.activeProfile;
      $$('.mode-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.mode === panelState.activeProfile);
      });
    }

    function switchMode(mode) {
      if (panelState.activeProfile === mode) return;
      panelState.activeProfile = mode;
      chrome.storage.sync.set({ activeProfile: mode });
      buildUI();
    }

    $$('.mode-btn').forEach((b) =>
      b.addEventListener('click', () => switchMode(b.dataset.mode))
    );

    $resetBtn.addEventListener('click', () => {
      if (!confirm('Reset both Trackpad and Mouse wheel settings to defaults?')) return;
      panelState.profiles = {
        mouse: { ...PANEL_DEFAULTS.mouse },
        trackpad: { ...PANEL_DEFAULTS.trackpad }
      };
      chrome.storage.sync.set({ profiles: panelState.profiles });
      buildUI();
    });

    $closeBtn.addEventListener('click', closeSettingsPanel);
    $backdrop.addEventListener('click', (e) => {
      if (e.target === $backdrop) closeSettingsPanel();
    });

    const onKey = (e) => { if (e.key === 'Escape') closeSettingsPanel(); };
    window.addEventListener('keydown', onKey, true);

    panelCleanup = () => {
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(saveTimer.t);
    };

    buildUI();
  }

  if (window === window.top && typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'toggle-settings') toggleSettingsPanel();
    });
  }

  // Panel and scrubber are independent; block scrubbing while the panel is open.
  // (The wheel handler already uses capture+passive:false, so we just insert a
  // guard at the top of the listener. Modify the existing handler like this:)
  //
  //   on(window, 'wheel', (event) => {
  //     if (isPanelOpen()) return;           // <-- add this line
  //     if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || ...
})();