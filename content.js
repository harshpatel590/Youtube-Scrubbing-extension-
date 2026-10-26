(() => {
  if (window.__mxScrubberLoaded) return;
  window.__mxScrubberLoaded = true;

  const CONFIG = {
    requireHover: true,          // Set true to only scrub when cursor is over the video
    activationThreshold: 140,    // DEADZONE: How much you must scroll to unlock scrubbing
    activationWindowMs: 400,     // Time window (ms) to reach threshold before resetting to 0
    settleDelayMs: 350,          // Split-second delay (ms) after you stop scrolling before playback resumes
    ytPixelsPerDelta: 0.35,      // Sensitivity on YouTube's timeline (higher = faster scrubbing)
    fallbackSecondsPerTick: 1.5, // Base scrub seconds on non-YouTube sites
    invertDirection: true,       // Reversed thumbwheel direction
    autoPlayAfterScrub: true,    // If true, always plays after scrubbing even if paused before

    /* ---- Dynamic scrub speed (fine-tune <-> fast scrub) ---- */
    dynamicScrubSpeed: true,     // Master switch for speed-sensitive scrubbing
    minSpeedMultiplier: 0.12,    // Slow scrolling  -> multiplier (fine tuning)
    maxSpeedMultiplier: 2.5,     // Fast scrolling  -> multiplier (big jumps)
    slowSpeed: 0.4,              // Scroll speed (px/ms) that maps to minSpeedMultiplier
    fastSpeed: 2.5,              // Scroll speed (px/ms) that maps to maxSpeedMultiplier
    speedSmoothing: 0.3,         // 0..1 EMA – higher = snappier, lower = smoother
    speedResetMs: 250            // Pause longer than this restarts the speed estimate
  };

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
   * POINTER FREEZE
   * While a scrub session is running, swallow real mouse / pointer moves
   * so YouTube (or any player) can't snap the playhead to the physical
   * cursor position. Our own synthetic events are untrusted (isTrusted
   * === false), so they are let through.
   * ------------------------------------------------------------------ */
  const BLOCKED_POINTER_EVENTS = ['mousemove', 'pointermove', 'pointerrawupdate'];

  function onBlockedPointerEvent(event) {
    if (!scrubState.active) return;
    if (!event.isTrusted) return; // allow our synthetic events
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  for (const type of BLOCKED_POINTER_EVENTS) {
    window.addEventListener(type, onBlockedPointerEvent, { capture: true, passive: true });
    document.addEventListener(type, onBlockedPointerEvent, { capture: true, passive: true });
  }

  /* ------------------------------------------------------------------ *
   * DYNAMIC SPEED
   * Measure how fast the horizontal wheel is spun (px per ms) and map
   * it logarithmically to a multiplier: slow spin = fine steps,
   * fast spin = large jumps. An EMA keeps the transition smooth.
   * ------------------------------------------------------------------ */
  function updateScrollSpeed(deltaX, now) {
    const dt = scrubState.lastWheelTime > 0
      ? Math.max(now - scrubState.lastWheelTime, 1)
      : 50;
    scrubState.lastWheelTime = now;

    const instantSpeed = Math.abs(deltaX) / dt;

    if (scrubState.smoothedSpeed === 0 || dt > CONFIG.speedResetMs) {
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
    t = t * t * (3 - 2 * t); // smoothstep for a soft ramp

    // Exponential interpolation: feels linear to the hand
    return minM * Math.pow(maxM / minM, t);
  }

  /* ------------------------------------------------------------------ */

  function getTargetVideo(mouseX, mouseY) {
    const videos = Array.from(document.querySelectorAll('video')).filter(
      (v) => v.readyState > 0 && v.duration > 0 && v.offsetWidth > 0
    );
    if (videos.length === 0) return null;

    for (const video of videos) {
      const rect = video.getBoundingClientRect();
      if (mouseX >= rect.left && mouseX <= rect.right && mouseY >= rect.top && mouseY <= rect.bottom) {
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
      if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth) {
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

  window.addEventListener(
    'wheel',
    (event) => {
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

      // Feed the speed tracker and get the current fine-tune/fast multiplier
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
    },
    { passive: false, capture: true }
  );
})();