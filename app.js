// ── Element refs ──────────────────────────────────────────────
const editView      = document.getElementById('edit-view');
const prompterView  = document.getElementById('prompter-view');
const scriptInput   = document.getElementById('script-input');   // contenteditable div
const scriptText    = document.getElementById('script-text');
const scrollContainer = document.getElementById('scroll-container');
const scrollContent   = document.getElementById('scroll-content');

const startBtn      = document.getElementById('start-btn');
const pasteBtn      = document.getElementById('paste-btn');
const editBtn       = document.getElementById('edit-btn');
const playPauseBtn  = document.getElementById('play-pause-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const speedSlider   = document.getElementById('speed-slider');
const sizeSlider    = document.getElementById('size-slider');
const speedVal      = document.getElementById('speed-val');
const sizeVal       = document.getElementById('size-val');
const mirrorToggle  = document.getElementById('mirror-toggle');
const flipVToggle   = document.getElementById('flip-v-toggle');
const progressLabel = document.getElementById('progress-label');
const timeLabel     = document.getElementById('time-label');
const hud           = document.getElementById('hud');

const settingsBtn      = document.getElementById('settings-btn');
const settingsPanel    = document.getElementById('settings-panel');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const marginSlider     = document.getElementById('margin-slider');
const marginVal        = document.getElementById('margin-val');
const cueToggle        = document.getElementById('cue-toggle');
const focusLine        = document.getElementById('focus-line');
const themeRadios      = document.querySelectorAll('input[name="theme"]');
const tapPauseToggle     = document.getElementById('tap-pause-toggle');
const countdownToggle    = document.getElementById('countdown-toggle');
const countdownOverlay   = document.getElementById('countdown-overlay');
const fontPicker         = document.getElementById('font-picker');

// ── State ──────────────────────────────────────────────────────
let isPlaying     = false;
let offsetY       = 0;        // fractional pixel offset for smooth slow speeds
let rafId         = null;
let lastTs        = null;
let hudTimeout    = null;
let wakeLock      = null;
let countdownId   = null;

// ── Screen Wake Lock ───────────────────────────────────────────
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) { /* silently ignore — not critical */ }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

// Re-acquire after tab regains visibility (required by the API)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' &&
      prompterView.classList.contains('active')) {
    acquireWakeLock();
  }
});

// Map slider value 1–25 linearly to 10–200 px/s
function getSpeed() {
  const t = (+speedSlider.value - 1) / 24; // 0 at min, 1 at max
  return Math.round(10 + t * 190);
}

// ── View switching ─────────────────────────────────────────────
function showPrompter() {
  const raw = scriptInput.innerHTML.trim();
  if (!raw || scriptInput.textContent.trim() === '') {
    alert('Please enter a script first.'); return;
  }

  scriptText.innerHTML = raw;
  applyFontSize(+sizeSlider.value);
  applyFont(fontPicker.value);

  editView.classList.remove('active');
  prompterView.classList.add('active');
  acquireWakeLock();

  // Wait one frame so the DOM has rendered and scrollHeight is accurate
  requestAnimationFrame(() => {
    resetScroll();
    updateProgress();
    showHud();
  });
}

function resetScroll() {
  offsetY = 0;
  scrollContent.style.transform = 'translateY(0)';
}

function showEditor() {
  stopScrolling();
  releaseWakeLock();
  prompterView.classList.remove('active');
  editView.classList.add('active');
}

startBtn.addEventListener('click', showPrompter);
editBtn.addEventListener('click', showEditor);

pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    scriptInput.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
    } else {
      scriptInput.textContent += text;
    }
  } catch {
    // Clipboard access denied or not supported
  }
});

// ── Play / Pause ───────────────────────────────────────────────
function cancelCountdown() {
  if (countdownId) { clearTimeout(countdownId); countdownId = null; }
  countdownOverlay.classList.remove('active');
}

function beginScrolling() {
  isPlaying = true;
  lastTs = null;
  playPauseBtn.textContent = 'II Pause';
  playPauseBtn.classList.add('is-playing');
  cancelMomentum();
  closeSettings();
  rafId = requestAnimationFrame(tick);
}

function startScrolling() {
  if (isPlaying || countdownId !== null) return;
  // If at the end, restart from the beginning
  const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
  if (offsetY >= maxScroll) resetScroll();

  if (countdownToggle.checked) {
    let n = 5;
    countdownOverlay.textContent = n;
    countdownOverlay.classList.add('active');
    playPauseBtn.textContent = 'II Pause';
    playPauseBtn.classList.add('is-playing');
    closeSettings();
    const step = () => {
      n--;
      if (n <= 0) {
        countdownOverlay.classList.remove('active');
        countdownId = null;
        beginScrolling();
        return;
      }
      countdownOverlay.textContent = n;
      countdownId = setTimeout(step, 1000);
    };
    countdownId = setTimeout(step, 1000);
    return;
  }

  beginScrolling();
}

function stopScrolling() {
  cancelCountdown();
  playPauseBtn.textContent = '▶ Play';
  playPauseBtn.classList.remove('is-playing');
  if (!isPlaying) return;
  isPlaying = false;
  cancelAnimationFrame(rafId);
  rafId = null;
  clearTimeout(hudTimeout);
  hud.classList.remove('dimmed'); // always show full controls when paused
}

function togglePlay() {
  if (isPlaying || countdownId !== null) {
    stopScrolling();
  } else {
    startScrolling();
  }
}

playPauseBtn.addEventListener('click', togglePlay);

// Spacebar to play/pause when in prompter view
document.addEventListener('keydown', (e) => {
  if (prompterView.classList.contains('active') && e.code === 'Space') {
    e.preventDefault();
    togglePlay();
    showHud();
  }
});

// ── Animation loop ─────────────────────────────────────────────
function tick(ts) {
  if (lastTs === null) lastTs = ts;
  const dt = (ts - lastTs) / 1000; // seconds
  lastTs = ts;

  const speed = getSpeed(); // px/s
  offsetY += speed * dt;

  scrollContent.style.transform = `translateY(-${offsetY}px)`;

  const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
  if (offsetY >= maxScroll) {
    offsetY = maxScroll;
    stopScrolling();
    showHud();
    return;
  }

  updateProgress();
  rafId = requestAnimationFrame(tick);
}

// ── Progress ───────────────────────────────────────────────────
function updateProgress() {
  const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
  if (maxScroll <= 0) return;
  const pct = Math.round((offsetY / maxScroll) * 100);
  const remainingPx = Math.max(0, maxScroll - offsetY);

  progressLabel.textContent = `${Math.max(0, Math.min(100, pct))}%`;

  const speedPxPerSec = getSpeed();
  const totalSec = Math.round(remainingPx / speedPxPerSec);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  timeLabel.textContent = `${m}:${String(s).padStart(2, '0')} left`;
}

// ── Controls ───────────────────────────────────────────────────
speedSlider.addEventListener('input', () => {
  speedVal.textContent = speedSlider.value;
  updateProgress();
});

// Touch scrub: drag anywhere on the speed control for fine-grained adjustment.
// Every SPEED_PX_PER_STEP pixels of horizontal drag = 1 unit change.
const SPEED_PX_PER_STEP = 12;
let speedDragStartX   = null;
let speedDragStartVal = null;

speedSlider.closest('label').addEventListener('touchstart', (e) => {
  speedDragStartX   = e.touches[0].clientX;
  speedDragStartVal = +speedSlider.value;
}, { passive: true });

speedSlider.closest('label').addEventListener('touchmove', (e) => {
  e.preventDefault();
  const steps  = Math.round((e.touches[0].clientX - speedDragStartX) / SPEED_PX_PER_STEP);
  const newVal = Math.max(+speedSlider.min, Math.min(+speedSlider.max, speedDragStartVal + steps));
  if (+speedSlider.value !== newVal) {
    speedSlider.value = newVal;
    speedSlider.dispatchEvent(new Event('input'));
  }
}, { passive: false });

speedSlider.closest('label').addEventListener('touchend', () => {
  speedDragStartX = speedDragStartVal = null;
});

sizeSlider.addEventListener('input', () => {
  applyFontSize(+sizeSlider.value);
  sizeVal.textContent = sizeSlider.value;
});

function applyFontSize(px) {
  scriptText.style.fontSize = px + 'px';
}

function applyFont(family) {
  scriptInput.style.fontFamily = family;
  scriptText.style.fontFamily  = family;
}

fontPicker.addEventListener('change', () => applyFont(fontPicker.value));

function applyTransform() {
  const h = mirrorToggle.classList.contains('active');
  const v = flipVToggle.classList.contains('active');

  // FlipV: rotate the entire scroll container 180°. This visually flips both axes,
  // so the spacer (DOM-bottom) becomes visual leading space and scroll direction
  // stays the same as normal mode (increasing scrollTop = reading forward).
  scrollContainer.style.transform = v ? 'rotate(180deg)' : '';

  // Counter the accidental horizontal flip caused by the container rotation.
  // When FlipH is also on, the two horizontal flips cancel → no x transform needed.
  const flipTextX = h !== v; // XOR: flip text horizontally when exactly one of H/V is active
  scriptText.style.transform = flipTextX ? 'scaleX(-1)' : '';

  // HUD labels: mirror each axis independently so the labels stay readable.
  // FlipH alone   → scale(-1,  1)
  // FlipV alone   → scale( 1, -1)
  // FlipH + FlipV → scale(-1, -1)
  const lx = h ? -1 : 1;
  const ly = v ? -1 : 1;
  const lt = (lx === 1 && ly === 1) ? '' : `scale(${lx},${ly})`;
  progressLabel.style.transform = lt;
  timeLabel.style.transform = lt;

  // Countdown overlay sits outside scroll-container, so mirror it independently
  const cx = h ? -1 : 1;
  const cy = v ? -1 : 1;
  countdownOverlay.style.transform = (cx === 1 && cy === 1) ? '' : `scale(${cx},${cy})`;
}

// ── Format toolbar ─────────────────────────────────────────────
document.querySelectorAll('.fmt-btn').forEach(btn => {
  if (!btn.dataset.cmd) return;
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault(); // keep focus in editor
    document.execCommand(btn.dataset.cmd, false, null);
    updateFormatState();
  });
});

// Highlight active format buttons based on current selection
function updateFormatState() {
  document.querySelectorAll('.fmt-btn').forEach(btn => {
    btn.classList.toggle('active', document.queryCommandState(btn.dataset.cmd));
  });
}

scriptInput.addEventListener('keyup',        updateFormatState);
scriptInput.addEventListener('mouseup',      updateFormatState);
scriptInput.addEventListener('selectionchange', updateFormatState);

// ── Paste sanitization ─────────────────────────────────────────
// Keep inline formatting tags; convert block elements to <br> line breaks.
const ALLOWED_INLINE = new Set(['B','STRONG','I','EM','U','BR']);
const BLOCK_TAGS     = new Set(['P','DIV','H1','H2','H3','H4','H5','H6',
                                 'LI','BLOCKQUOTE','PRE','TR','SECTION','ARTICLE']);

function sanitizeNode(src, dest) {
  src.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      dest.appendChild(document.createTextNode(node.textContent));
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (ALLOWED_INLINE.has(node.tagName)) {
        const el = document.createElement(node.tagName);
        sanitizeNode(node, el);
        dest.appendChild(el);
      } else {
        // Detect style-based formatting (Google Docs uses spans with inline styles
        // instead of semantic tags like <em>/<strong>)
        const s = node.style;
        let container = dest;
        if (s.fontStyle === 'italic') {
          const el = document.createElement('em');
          container.appendChild(el);
          container = el;
        }
        if (s.fontWeight === 'bold' || parseInt(s.fontWeight) >= 600) {
          const el = document.createElement('strong');
          container.appendChild(el);
          container = el;
        }
        if (s.textDecoration.includes('underline') || s.textDecorationLine.includes('underline')) {
          const el = document.createElement('u');
          container.appendChild(el);
          container = el;
        }
        sanitizeNode(node, container);
        // Add a <br> between block elements, but not after the last one
        if (BLOCK_TAGS.has(node.tagName)) {
          let next = node.nextSibling;
          while (next && next.nodeType === Node.TEXT_NODE && !next.textContent.trim()) {
            next = next.nextSibling;
          }
          if (next) dest.appendChild(document.createElement('br'));
        }
      }
    }
  });
}

// Remove double <br>s (from trailing <br> inside block elements) and any trailing <br>
function collapseBrs(el) {
  el.querySelectorAll('br').forEach(br => {
    let prev = br.previousSibling;
    while (prev && prev.nodeType === Node.TEXT_NODE && !prev.textContent.trim()) prev = prev.previousSibling;
    if (prev && prev.nodeName === 'BR') br.remove();
  });
  while (el.lastChild && el.lastChild.nodeName === 'BR') el.lastChild.remove();
}

function buildSanitizedDiv(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const frag = document.createDocumentFragment();
  sanitizeNode(doc.body, frag);
  const tmp = document.createElement('div');
  tmp.appendChild(frag);
  collapseBrs(tmp);
  return tmp;
}

scriptInput.addEventListener('paste', (e) => {
  e.preventDefault();
  const html = e.clipboardData.getData('text/html');
  if (html) {
    document.execCommand('insertHTML', false, buildSanitizedDiv(html).innerHTML);
  } else {
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }
});

// ── Settings panel ─────────────────────────────────────────────
function openSettings() {
  settingsPanel.classList.add('open');
  clearTimeout(hudTimeout); // keep HUD fully visible while settings are open
  hud.classList.remove('dimmed');
}

function closeSettings() {
  settingsPanel.classList.remove('open');
  if (isPlaying) hudTimeout = setTimeout(dimHud, 3000);
}

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel.classList.contains('open') ? closeSettings() : openSettings();
  showHud();
});

settingsCloseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  closeSettings();
});

// Prevent panel clicks from bubbling to the prompter (which toggles play)
settingsPanel.addEventListener('click', (e) => e.stopPropagation());

// Margin slider
marginSlider.addEventListener('input', () => {
  const vw = marginSlider.value;
  marginVal.textContent = vw;
  scriptText.style.paddingLeft  = vw + 'vw';
  scriptText.style.paddingRight = vw + 'vw';
});

// Cue line
cueToggle.addEventListener('change', () => {
  focusLine.classList.toggle('visible', cueToggle.checked);
});

// Theme
themeRadios.forEach(radio => {
  radio.addEventListener('change', () => {
    prompterView.dataset.theme = radio.value;
  });
});

// Don't dim the HUD while settings panel is open
function dimHud() {
  if (!isPlaying) return;
  if (settingsPanel.classList.contains('open')) return;
  hud.classList.add('dimmed');
}

mirrorToggle.addEventListener('click', () => {
  mirrorToggle.classList.toggle('active');
  applyTransform();
});
flipVToggle.addEventListener('click', () => {
  flipVToggle.classList.toggle('active');
  applyTransform();
  // Move cue line to mirror position when flipped
  focusLine.style.top = flipVToggle.classList.contains('active') ? '67%' : '33%';
  // Re-anchor scroll position to the correct end for the new direction
  if (prompterView.classList.contains('active')) {
    stopScrolling();
    resetScroll();
  }
});

// ── Manual scroll (wheel + touch) ─────────────────────────────
// Adjusts offsetY directly so playback resumes from the new position.

scrollContainer.addEventListener('wheel', (e) => {
  e.preventDefault();
  const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
  if (tapPauseToggle.checked) stopScrolling();
  offsetY = Math.max(0, Math.min(offsetY + e.deltaY, maxScroll));
  scrollContent.style.transform = `translateY(-${offsetY}px)`;
  updateProgress();
  showHud();
}, { passive: false });

let touchStartY    = null;
let touchVelocity  = 0;   // px/ms — positive = scrolling forward
let touchLastTime  = null;
let momentumId     = null;
let momentumTs     = null;

function cancelMomentum() {
  if (momentumId) { cancelAnimationFrame(momentumId); momentumId = null; }
  momentumTs = null;
}

function runMomentum(ts) {
  if (momentumTs === null) momentumTs = ts;
  const dt = ts - momentumTs;
  momentumTs = ts;

  const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
  offsetY = Math.max(0, Math.min(offsetY + touchVelocity * dt, maxScroll));
  scrollContent.style.transform = `translateY(-${offsetY}px)`;
  updateProgress();

  // Friction: ~0.995 per ms gives a natural ~1s coast
  touchVelocity *= Math.pow(0.995, dt);

  if (Math.abs(touchVelocity) < 0.05) { momentumId = null; momentumTs = null; return; }
  momentumId = requestAnimationFrame(runMomentum);
}

scrollContainer.addEventListener('touchstart', (e) => {
  cancelMomentum();
  if (tapPauseToggle.checked) stopScrolling();
  touchStartY   = e.touches[0].clientY;
  touchLastTime = e.timeStamp;
  touchVelocity = 0;
}, { passive: true });

scrollContainer.addEventListener('touchmove', (e) => {
  if (touchStartY === null) return;
  e.preventDefault();
  const dy = touchStartY - e.touches[0].clientY; // positive = swiped up
  touchStartY = e.touches[0].clientY;

  const dt = e.timeStamp - touchLastTime;
  touchLastTime = e.timeStamp;

  // Smooth velocity in px/ms (weighted average to reduce jitter)
  const rawVel = dt > 0 ? dy / dt : 0;
  touchVelocity = touchVelocity * 0.4 + rawVel * 0.6;

  const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
  offsetY = Math.max(0, Math.min(offsetY + dy, maxScroll));
  scrollContent.style.transform = `translateY(-${offsetY}px)`;
  updateProgress();
  showHud();
}, { passive: false });

scrollContainer.addEventListener('touchend', () => {
  touchStartY = null;
  if (Math.abs(touchVelocity) > 0.05) {
    momentumId = requestAnimationFrame(runMomentum);
  }
});

// ── Fullscreen ─────────────────────────────────────────────────
fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    prompterView.requestFullscreen().catch(console.error);
  } else {
    document.exitFullscreen();
  }
});

document.addEventListener('fullscreenchange', () => {
  fullscreenBtn.textContent = document.fullscreenElement ? '✕ Exit' : '⛶ Fullscreen';
});

// ── HUD auto-dim ───────────────────────────────────────────────
function showHud() {
  hud.classList.add('visible');
  hud.classList.remove('hidden', 'dimmed');
  clearTimeout(hudTimeout);
  if (isPlaying) {
    hudTimeout = setTimeout(dimHud, 3000);
  }
}

prompterView.addEventListener('mousemove', () => {
  if (prompterView.classList.contains('active')) showHud();
});

prompterView.addEventListener('click', (e) => {
  // Clicks on the background toggle play; HUD buttons handle themselves
  if (e.target === prompterView || e.target === scrollContainer) {
    if (tapPauseToggle.checked) {
      stopScrolling();
    } else {
      togglePlay();
    }
  }
  showHud();
});

// Initialise HUD as visible
showHud();
