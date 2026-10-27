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

const SCHEMA = [
  {
    title: 'Activation',
    fields: [
      { key: 'requireHover', label: 'Require hover over video', type: 'bool',
        help: 'Only scrub when the cursor is over the video' },
      { key: 'activationThreshold', label: 'Activation threshold', type: 'range',
        min: 20, max: 500, step: 10, unit: 'px',
        help: 'Scroll distance needed to unlock scrubbing' },
      { key: 'activationWindowMs', label: 'Activation window', type: 'range',
        min: 100, max: 2000, step: 50, unit: 'ms' }
    ]
  },
  {
    title: 'Direction & Playback',
    fields: [
      { key: 'invertDirection', label: 'Invert scroll direction', type: 'bool',
        help: 'Flip this if scrubbing feels backwards' },
      { key: 'autoPlayAfterScrub', label: 'Always play after scrub', type: 'bool' },
      { key: 'settleDelayMs', label: 'Settle delay', type: 'range',
        min: 0, max: 2000, step: 50, unit: 'ms',
        help: 'Delay before playback resumes' }
    ]
  },
  {
    title: 'Sensitivity',
    fields: [
      { key: 'ytPixelsPerDelta', label: 'YouTube scrub sensitivity', type: 'range',
        min: 0.05, max: 2, step: 0.01,
        help: 'Pixels of timeline per scroll unit' },
      { key: 'fallbackSecondsPerTick', label: 'Fallback seconds per tick', type: 'range',
        min: 0.1, max: 5, step: 0.1, unit: 's',
        help: 'Base step on non-YouTube sites' }
    ]
  },
  {
    title: 'Dynamic Speed',
    fields: [
      { key: 'dynamicScrubSpeed', label: 'Enable dynamic speed', type: 'bool',
        help: 'Slow scroll = fine tuning, fast scroll = coarse' },
      { key: 'minSpeedMultiplier', label: 'Min multiplier', type: 'range',
        min: 0.01, max: 1, step: 0.01, unit: '×' },
      { key: 'maxSpeedMultiplier', label: 'Max multiplier', type: 'range',
        min: 0.5, max: 5, step: 0.1, unit: '×',
        help: 'Lower to tame aggressive fast scrubs' },
      { key: 'slowSpeed', label: 'Slow speed threshold', type: 'range',
        min: 0.1, max: 10, step: 0.1, unit: 'px/ms' },
      { key: 'fastSpeed', label: 'Fast speed threshold', type: 'range',
        min: 0.5, max: 15, step: 0.1, unit: 'px/ms',
        help: 'Raise to require more spin to reach max' },
      { key: 'speedSmoothing', label: 'Smoothing', type: 'range',
        min: 0.05, max: 1, step: 0.01,
        help: 'Higher = snappier, lower = smoother' },
      { key: 'speedResetMs', label: 'Speed reset window', type: 'range',
        min: 50, max: 1000, step: 10, unit: 'ms',
        help: 'Idle gap that restarts the speed estimate' }
    ]
  }
];

const state = {
  activeProfile: 'mouse',
  profiles: {
    mouse: { ...MOUSE_DEFAULTS },
    trackpad: { ...TRACKPAD_DEFAULTS }
  }
};

const $sections = document.getElementById('sections');
const $toast = document.getElementById('toast');
const $modeSwitch = document.querySelector('.mode-switch');
let saveTimer = null;

function values() { return state.profiles[state.activeProfile]; }

function profileLabel(mode) {
  return mode === 'mouse' ? 'Mouse wheel' : 'Trackpad';
}

function showToast(text = 'Saved') {
  $toast.textContent = text;
  $toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => $toast.classList.remove('show'), 1300);
}

function formatValue(field, value) {
  return Number(field.step) < 1 ? Number(value).toFixed(2) : value;
}

function setFill(input, field) {
  const v = parseFloat(input.value);
  const pct = ((v - field.min) / (field.max - field.min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

function saveValue(key, value) {
  values()[key] = value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.sync.set({ profiles: state.profiles }, () => {
      showToast(`Saved · ${profileLabel(state.activeProfile)}`);
    });
  }, 120);
}

function buildField(field) {
  const wrap = document.createElement('div');
  wrap.className = 'field';

  if (field.type === 'bool') {
    const label = document.createElement('label');
    label.className = 'toggle';
    const text = document.createElement('span');
    text.className = 'toggle-label';
    text.textContent = field.label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!values()[field.key];
    input.addEventListener('change', () => saveValue(field.key, input.checked));
    const track = document.createElement('span');
    track.className = 'toggle-track';
    label.appendChild(text);
    label.appendChild(input);
    label.appendChild(track);
    wrap.appendChild(label);
    if (field.help) {
      const h = document.createElement('div');
      h.className = 'help';
      h.textContent = field.help;
      wrap.appendChild(h);
    }
    return wrap;
  }

  const header = document.createElement('div');
  header.className = 'field-header';
  const label = document.createElement('span');
  label.textContent = field.label;
  const valSpan = document.createElement('span');
  valSpan.className = 'value';
  const renderVal = (v) => formatValue(field, v) + (field.unit ? ' ' + field.unit : '');
  valSpan.textContent = renderVal(values()[field.key]);
  header.appendChild(label);
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
    valSpan.textContent = renderVal(v);
    setFill(input, field);
    saveValue(field.key, v);
  });
  wrap.appendChild(input);

  if (field.help) {
    const h = document.createElement('div');
    h.className = 'help';
    h.textContent = field.help;
    wrap.appendChild(h);
  }
  return wrap;
}

function buildUI() {
  $sections.innerHTML = '';
  SCHEMA.forEach((section, i) => {
    const el = document.createElement('section');
    el.className = 'section';
    el.style.animationDelay = `${i * 50}ms`;
    const h2 = document.createElement('h2');
    h2.textContent = section.title;
    el.appendChild(h2);
    for (const field of section.fields) el.appendChild(buildField(field));
    $sections.appendChild(el);
  });
}

function syncModeButtons() {
  $modeSwitch.dataset.active = state.activeProfile;
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.activeProfile);
  });
}

function switchProfile(mode) {
  if (state.activeProfile === mode) return;
  state.activeProfile = mode;
  syncModeButtons();
  chrome.storage.sync.set({ activeProfile: mode }, () => {
    buildUI();
    showToast(`Switched to ${profileLabel(mode)}`);
  });
}

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchProfile(btn.dataset.mode));
});

async function loadValues() {
  const stored = await chrome.storage.sync.get(['activeProfile', 'profiles']);
  if (stored.activeProfile === 'mouse' || stored.activeProfile === 'trackpad') {
    state.activeProfile = stored.activeProfile;
  }
  if (stored.profiles) {
    if (stored.profiles.mouse) Object.assign(state.profiles.mouse, stored.profiles.mouse);
    if (stored.profiles.trackpad) Object.assign(state.profiles.trackpad, stored.profiles.trackpad);
  } else {
    // First launch — persist defaults so the content script and popup agree.
    await chrome.storage.sync.set({
      profiles: state.profiles,
      activeProfile: state.activeProfile
    });
  }
}

document.getElementById('reset').addEventListener('click', async () => {
  if (!confirm('Reset both Trackpad and Mouse wheel settings to defaults?')) return;
  await chrome.storage.sync.clear();
  state.profiles = {
    mouse: { ...MOUSE_DEFAULTS },
    trackpad: { ...TRACKPAD_DEFAULTS }
  };
  // Keep whatever mode the user is currently on.
  await chrome.storage.sync.set({
    profiles: state.profiles,
    activeProfile: state.activeProfile
  });
  syncModeButtons();
  buildUI();
  showToast('Reset all modes');
});

document.getElementById('reload-tab').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.reload(tab.id);
    window.close();
  }
});

document.getElementById('reload-ext').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.reload(tab.id);
  } catch {}
  setTimeout(() => chrome.runtime.reload(), 150);
});

(async () => {
  await loadValues();
  syncModeButtons();
  buildUI();
})();