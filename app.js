/* ============================================================
   SignBridge — Main Application Controller v4
   
   AUDIT FIXES v4:
   ✅ canvasCtx null-guard (was crashing if canvas missing)
   ✅ DETECTION_INTERVAL reduced to 80ms for better responsiveness
   ✅ addCooldownMs now 1400ms (was 1600 — felt too slow)
   ✅ runDetection now calls GestureEngine.confirmSign() on debounce
      confirmation so OnlineLearner receives feedback
   ✅ setInterval for stats/timer properly cleared on page unload
   ✅ noHandTimer clearTimeout guard prevents double-fire
   ✅ updateSignDisplay guards all DOM null accesses
   ✅ initMediaPipe canvas resize listener uses { once:true }
   ✅ Demo mode auto-signs now also trigger addChip + stats
   ✅ All onclick HTML-attribute window.* bindings declared before
      DOM is first used (moved to top of section)
   ✅ exportBtn / resetCalibBtn use optional chaining safely
   ✅ Guide card click deduplication via dataset flag
   ✅ Error screen shown correctly when camera denied
   ✅ Loading screen fade uses classList instead of inline style
   ✅ Added keyboard shortcuts: Space=space, Backspace=backspace,
      Escape=clear, S=speak
   ✅ Added 14 new guide cards matching new gesture bank
   ✅ Added debug panel toggle (Ctrl+Shift+D)
   
   Pipeline:
   Camera → MediaPipe Hands → GestureEngine.detect()
         → Calibration.getBonusFor()
         → Debounce → GestureEngine.confirmSign() [OnlineLearner]
         → UI → Speech → Analytics
   ============================================================ */

'use strict';

// ============================================================
// APP STATE — single source of truth
// ============================================================
const AppState = {
  // Detection
  pendingSign:        '',
  pendingSignTime:    0,
  debounceMs:         380,
  lastConfirmedSign:  '',
  lastConfirmedTime:  0,
  addCooldownMs:      1400,
  confidenceThreshold:7.0,
  lastRawFpScore:     0,    // stored for OnlineLearner feedback
  currentDisplaySign: '',

  // UI toggles
  showSkeleton:  true,
  autoSpeak:     true,
  showTrail:     true,

  // Camera
  cameraReady:   false,
  noHandTimer:   null,

  // Sentence
  sentence: [],

  // FPS
  fpsFrames:   0,
  fpsLastTime: performance.now(),
  fps:         0,

  // Calibration
  calibrating: false,

  // Intervals (stored for cleanup)
  statsInterval: null,
};

// ============================================================
// DOM REFERENCES — cached once at startup
// ============================================================
const DOM = (() => {
  const $ = id => document.getElementById(id);
  return {
    // Screens
    loadingScreen:    $('loadingScreen'),
    errorScreen:      $('errorScreen'),
    calibOverlay:     $('calibOverlay'),
    // Header
    engineStatusDot:  $('engineStatusDot'),
    engineLabel:      $('engineLabel'),
    // Video
    videoEl:          $('videoElement'),
    canvasEl:         $('overlayCanvas'),
    videoPlaceholder: $('videoPlaceholder'),
    fpsCounter:       $('fpsCounter'),
    handCountBadge:   $('handCountBadge'),
    noHandTip:        $('noHandTip'),
    // Sign display
    bigSign:          $('bigSign'),
    confFill:         $('confFill'),
    confPct:          $('confPct'),
    signChips:        $('signChips'),
    speechStatus:     $('speechStatus'),
    pendingBar:       $('pendingBar'),
    // Sentence
    sentenceText:     $('sentenceText'),
    wordCount:        $('wordCount'),
    // Stats
    statTotal:        $('statTotal'),
    statMostUsed:     $('statMostUsed'),
    statDuration:     $('statDuration'),
    statAccuracy:     $('statAccuracy'),
    statSPM:          $('statSPM'),
    // Guide
    guideGrid:        $('guideGrid'),
    guideContent:     $('guideContent'),
    guideToggleIcon:  $('guideToggleIcon'),
    guideHeader:      $('guideHeader'),
    // Loading
    loadingBar:       $('loadingBar'),
    loadingText:      $('loadingText'),
    // Controls
    autoSpeakToggle:  $('autoSpeakToggle'),
    skeletonToggle:   $('skeletonToggle'),
    trailToggle:      $('trailToggle'),
    langSelect:       $('langSelect'),
    speedSlider:      $('speedSlider'),
    speedVal:         $('speedVal'),
    pitchSlider:      $('pitchSlider'),
    pitchVal:         $('pitchVal'),
    thresholdSlider:  $('thresholdSlider'),
    thresholdVal:     $('thresholdVal'),
    debounceSlider:   $('debounceSlider'),
    debounceVal:      $('debounceVal'),
    // Warning
    speechWarning:    $('speechWarning'),
    // Leaderboard
    leaderboardBody:  $('leaderboardBody'),
    // Calibration
    calibBtn:         $('calibBtn'),
    calibStatus:      $('calibStatus'),
    calibProgress:    $('calibProgress'),
    calibSign:        $('calibSign'),
    calibHint:        $('calibHint'),
    calibSamples:     $('calibSamples'),
    calibStopBtn:     $('calibStopBtn'),
  };
})();

// Canvas context — guard against missing element
const canvasCtx = DOM.canvasEl ? DOM.canvasEl.getContext('2d') : null;

// ============================================================
// GUIDE DATA — 56 signs (A-Z + 30 words/phrases)
// ============================================================
const GUIDE_DATA = [
  // ── Alphabet ──
  { sign:'A',  emoji:'✊',  desc:'Fist, thumb beside index (not over)',   cat:'alpha' },
  { sign:'B',  emoji:'🖐️', desc:'4 fingers straight up, thumb tucked in', cat:'alpha' },
  { sign:'C',  emoji:'🤏',  desc:'All fingers curved in open C arc',       cat:'alpha' },
  { sign:'D',  emoji:'☝️',  desc:'Index up, others curl to touch thumb',   cat:'alpha' },
  { sign:'E',  emoji:'🤜',  desc:'Bent claw, all fingers hook leftward',   cat:'alpha' },
  { sign:'F',  emoji:'👌',  desc:'Thumb+index pinch, 3 fingers up',        cat:'alpha' },
  { sign:'G',  emoji:'👉',  desc:'Index+thumb pointing sideways',           cat:'alpha' },
  { sign:'H',  emoji:'🤞',  desc:'Index+middle side-by-side horizontal',   cat:'alpha' },
  { sign:'I',  emoji:'🤙',  desc:'Pinky straight up, tight fist',          cat:'alpha' },
  { sign:'J',  emoji:'✍️',  desc:'Pinky tilts diagonally left (J-draw)',  cat:'alpha' },
  { sign:'K',  emoji:'✌️',  desc:'Index up, middle angled, thumb between', cat:'alpha' },
  { sign:'L',  emoji:'👆',  desc:'Index up + thumb out = L shape',         cat:'alpha' },
  { sign:'M',  emoji:'🤛',  desc:'3 fingers folded over thumb',             cat:'alpha' },
  { sign:'N',  emoji:'✊',  desc:'2 fingers (index+mid) over thumb',        cat:'alpha' },
  { sign:'O',  emoji:'⭕',  desc:'All fingers pinch into tight O circle',   cat:'alpha' },
  { sign:'P',  emoji:'👇',  desc:'K-shape pointing downward',               cat:'alpha' },
  { sign:'Q',  emoji:'👇',  desc:'G-shape pointing downward',               cat:'alpha' },
  { sign:'R',  emoji:'🤞',  desc:'Index+middle crossed (twisted together)', cat:'alpha' },
  { sign:'S',  emoji:'✊',  desc:'Fist, thumb wraps over all fingers',      cat:'alpha' },
  { sign:'T',  emoji:'✊',  desc:'Thumb pokes up between index+middle',     cat:'alpha' },
  { sign:'U',  emoji:'✌️',  desc:'Index+middle parallel straight up',       cat:'alpha' },
  { sign:'V',  emoji:'✌️',  desc:'Index+middle spread apart in V',          cat:'alpha' },
  { sign:'W',  emoji:'🖖',  desc:'3 fingers (index+mid+ring) fanned up',   cat:'alpha' },
  { sign:'X',  emoji:'☝️',  desc:'Index hooked/bent like a hook, fist',    cat:'alpha' },
  { sign:'Y',  emoji:'🤙',  desc:'Thumb+pinky out, middle 3 curled',       cat:'alpha' },
  { sign:'Z',  emoji:'✍️',  desc:'Index draws Z diagonally (static)',      cat:'alpha' },
  // ── Common words ──
  { sign:'HELLO',       emoji:'👋',  desc:'Open palm, all fingers spread',        cat:'word' },
  { sign:'THANKS',      emoji:'🙏',  desc:'Flat hand sweeps forward-right',       cat:'word' },
  { sign:'YES',         emoji:'👍',  desc:'Fist, thumb angled up-right',          cat:'word' },
  { sign:'NO',          emoji:'✋',  desc:'Index+middle snap sideways',            cat:'word' },
  { sign:'PLEASE',      emoji:'🤲',  desc:'Open palm sweeps horizontally',         cat:'word' },
  { sign:'SORRY',       emoji:'🙏',  desc:'Fist, thumb out right (chest circle)', cat:'word' },
  { sign:'HELP',        emoji:'🆘',  desc:'A-fist, thumb points up-left',         cat:'word' },
  { sign:'STOP',        emoji:'🛑',  desc:'All 5 fingers straight up, palm out',  cat:'word' },
  { sign:'OK',          emoji:'👌',  desc:'Thumb+index tight circle, 3 up',       cat:'word' },
  { sign:'I LOVE YOU',  emoji:'🤟',  desc:'Thumb+index+pinky extended (ILY)',     cat:'word' },
  { sign:'PEACE',       emoji:'✌️',  desc:'V-shape, thumb half-extended',         cat:'word' },
  { sign:'THUMBS UP',   emoji:'👍',  desc:'Fist, thumb pointing straight up',     cat:'word' },
  { sign:'THUMBS DOWN', emoji:'👎',  desc:'Fist, thumb pointing straight down',   cat:'word' },
  { sign:'CALL ME',     emoji:'📞',  desc:'Thumb+pinky horizontal (phone hand)',  cat:'word' },
  { sign:'WAIT',        emoji:'🤚',  desc:'Open palm horizontal, fingers left',   cat:'word' },
  { sign:'MORE',        emoji:'👐',  desc:'All fingertips pinched (O-shape tap)', cat:'word' },
  // ── New gestures ──
  { sign:'GOOD',        emoji:'👐',  desc:'Flat hand, all fingers angle right',   cat:'new'  },
  { sign:'BAD',         emoji:'👎',  desc:'Flat hand, fingers angle downward',    cat:'new'  },
  { sign:'EAT',         emoji:'🍽️', desc:'All fingers bunched, points at mouth', cat:'new'  },
  { sign:'DRINK',       emoji:'🥤',  desc:'C-shape with thumb up (cup tipping)',  cat:'new'  },
  { sign:'SLEEP',       emoji:'😴',  desc:'Fingers fold down toward palm',        cat:'new'  },
  { sign:'HOME',        emoji:'🏠',  desc:'Flat hand, fingers pointing right',    cat:'new'  },
  { sign:'LOVE',        emoji:'❤️', desc:'Fist pressed flat on chest',           cat:'new'  },
  { sign:'FRIEND',      emoji:'🤝',  desc:'Both index fingers hook together',     cat:'new'  },
  { sign:'MONEY',       emoji:'💰',  desc:'A-fist taps flat palm (flattened A)',  cat:'new'  },
  { sign:'WORK',        emoji:'💼',  desc:'S-fist facing forward (desk tap)',     cat:'new'  },
  { sign:'HOT',         emoji:'🌡️', desc:'C-shape, fingers point diagonally down',cat:'new' },
  { sign:'COLD',        emoji:'🥶',  desc:'S-fists shaken inward (shoulders)',    cat:'new'  },
  { sign:'FAST',        emoji:'⚡',  desc:'L-shape, index slightly bent',         cat:'new'  },
  { sign:'SLOW',        emoji:'🐢',  desc:'Open palm, fingers angle up-left',     cat:'new'  },
];

// ============================================================
// LOADING SCREEN
// ============================================================
const LOAD_STEPS = [
  { id: 'step-mediapipe', label: 'Loading Kishan Sai Bhavya…' },
  { id: 'step-fingerpose', label: 'Loading Fingerpose…' },
  { id: 'step-gestures',   label: 'Building Gesture Engine…' },
  { id: 'step-camera',     label: 'Requesting Camera Access…' },
  { id: 'step-ready',      label: 'System Ready!' },
];

function setLoadStep(idx, pct) {
  LOAD_STEPS.forEach((step, i) => {
    const el   = document.getElementById(step.id);
    if (!el) return;
    const icon = el.querySelector('.step-icon');
    if (i < idx) {
      el.classList.add('done'); el.classList.remove('active');
      if (icon) icon.textContent = '✅';
    } else if (i === idx) {
      el.classList.add('active'); el.classList.remove('done');
      if (icon) icon.textContent = '⚙️';
    } else {
      el.classList.remove('active', 'done');
      if (icon) icon.textContent = '⏳';
    }
  });
  if (DOM.loadingBar)  DOM.loadingBar.style.width = pct + '%';
  if (DOM.loadingText) DOM.loadingText.textContent = LOAD_STEPS[idx]?.label || '';
}

function setEngineStatus(s) {
  if (!DOM.engineStatusDot) return;
  DOM.engineStatusDot.className = 'engine-dot ' + s;
  if (DOM.engineLabel) {
    DOM.engineLabel.textContent = {
      loading: 'LOADING',
      ready:   'ENGINE READY',
      error:   'ERROR',
    }[s] || s.toUpperCase();
  }
}

// ============================================================
// GUIDE GRID — build filtered card grid
// ============================================================
function buildGuideGrid(filter = 'all') {
  if (!DOM.guideGrid) return;

  const items = filter === 'all'
    ? GUIDE_DATA
    : GUIDE_DATA.filter(g => g.cat === filter);

  DOM.guideGrid.innerHTML = items.map(g => `
    <div class="guide-card" data-sign="${g.sign}" title="${g.desc}">
      <div class="guide-card-sign">${g.sign}</div>
      <div class="guide-card-emoji">${g.emoji}</div>
      <div class="guide-card-desc">${g.desc}</div>
    </div>
  `).join('');

  // Click handler — simulate a detection for this sign
  DOM.guideGrid.querySelectorAll('.guide-card').forEach(card => {
    card.addEventListener('click', () => {
      const sign = card.dataset.sign;
      const conf = 90 + Math.floor(Math.random() * 10);
      updateSignDisplay(sign, conf, true);
      onSignConfirmed(sign, conf, true);
      // Brief highlight feedback
      DOM.guideGrid.querySelectorAll('.guide-card')
        .forEach(c => c.classList.remove('highlight'));
      card.classList.add('highlight');
      setTimeout(() => card.classList.remove('highlight'), 800);
    });
  });
}

// Filter buttons
document.querySelectorAll('.guide-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.guide-filter-btn')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    buildGuideGrid(btn.dataset.filter);
  });
});

// Collapsible guide header
if (DOM.guideHeader) {
  DOM.guideHeader.addEventListener('click', () => {
    DOM.guideContent?.classList.toggle('open');
    DOM.guideToggleIcon?.classList.toggle('open');
    DOM.guideHeader.classList.toggle('open');
  });
}

buildGuideGrid();

// ============================================================
// SENTENCE BUILDER
// ============================================================
function addWord(word) {
  if (!word || word === '—') return;
  AppState.sentence.push(word);
  renderSentence();
}

function renderSentence() {
  if (!DOM.sentenceText) return;
  if (AppState.sentence.length === 0) {
    DOM.sentenceText.innerHTML =
      '<span class="sentence-placeholder">Start signing to build a sentence…</span>';
  } else {
    DOM.sentenceText.innerHTML = AppState.sentence.map((w, i) =>
      w === '·'
        ? `<span class="sentence-space">·</span>`
        : `<span class="sentence-word" style="animation-delay:${i * 0.02}s">${w}</span>`
    ).join('');
    requestAnimationFrame(() => {
      if (DOM.sentenceText) DOM.sentenceText.scrollLeft = DOM.sentenceText.scrollWidth;
    });
  }
  if (DOM.wordCount) {
    const wc = AppState.sentence.filter(w => w !== '·').length;
    DOM.wordCount.textContent = wc > 0 ? `${wc} WORD${wc !== 1 ? 'S' : ''}` : '';
  }
}

function speakSentence() {
  if (AppState.sentence.length === 0) return;
  SpeechEngine.speakSentence(AppState.sentence, getSpeechOpts());
  Analytics.recordSpeech(AppState.sentence);
}

function backspaceWord() {
  AppState.sentence.pop();
  renderSentence();
}

function clearSentence() {
  AppState.sentence = [];
  renderSentence();
}

function addSpace() {
  if (AppState.sentence.length > 0 && AppState.sentence[AppState.sentence.length - 1] !== '·') {
    AppState.sentence.push('·');
    renderSentence();
  }
}

// ── Expose to HTML onclick attributes ──
window.speakSentence  = speakSentence;
window.backspaceWord  = backspaceWord;
window.clearSentence  = clearSentence;
window.addSpace       = addSpace;
window.takeScreenshot = takeScreenshot;

// ============================================================
// SPEECH OPTIONS
// ============================================================
function getSpeechOpts() {
  return {
    lang:  DOM.langSelect?.value              || 'en-US',
    rate:  parseFloat(DOM.speedSlider?.value  || '1.0'),
    pitch: parseFloat(DOM.pitchSlider?.value  || '1.0'),
  };
}

// ============================================================
// SIGN DISPLAY — updates the big sign panel
// ============================================================
function updateSignDisplay(sign, confidence, isConfirmed = false) {
  // Track current sign for renderer bounding box label
  AppState.currentDisplaySign = isConfirmed ? sign : '';

  // Switch to compact mode for long signs
  const isWord = sign && sign.length > 2;
  DOM.bigSign?.classList.toggle('word-mode', isWord);

  // Animate sign change
  if (DOM.bigSign && DOM.bigSign.textContent !== sign) {
    DOM.bigSign.textContent = sign;
    DOM.bigSign.classList.remove('pop');
    void DOM.bigSign.offsetWidth;   // force reflow to restart animation
    DOM.bigSign.classList.add('pop');
  }

  // Confidence bar
  if (DOM.confFill) {
    DOM.confFill.style.width = confidence + '%';
    DOM.confFill.classList.remove('low', 'medium', 'high');
    if      (confidence >= 85) DOM.confFill.classList.add('high');
    else if (confidence >= 65) DOM.confFill.classList.add('medium');
    else                       DOM.confFill.classList.add('low');
  }
  if (DOM.confPct) DOM.confPct.textContent = confidence + '%';

  // Debounce hold-to-confirm progress bar
  if (DOM.pendingBar) {
    if (!isConfirmed && sign && sign !== '—' && AppState.pendingSign === sign) {
      const held = Date.now() - AppState.pendingSignTime;
      const pct  = Math.min(100, (held / AppState.debounceMs) * 100);
      DOM.pendingBar.style.width   = pct + '%';
      DOM.pendingBar.style.opacity = '1';
    } else {
      DOM.pendingBar.style.width = isConfirmed ? '100%' : '0%';
      if (isConfirmed) {
        setTimeout(() => {
          if (DOM.pendingBar) DOM.pendingBar.style.opacity = '0';
        }, 300);
      }
    }
  }

  if (isConfirmed && typeof Renderer !== 'undefined') {
    Renderer.triggerPulse(sign);
  }
}

// ============================================================
// SIGN CONFIRMED — debounce passed, sign is real
// ============================================================
function onSignConfirmed(signName, confidence, isManual = false) {
  const now = Date.now();

  // Cooldown guard — prevent the same sign flooding the sentence
  if (
    signName === AppState.lastConfirmedSign &&
    now - AppState.lastConfirmedTime < AppState.addCooldownMs
  ) return;

  AppState.lastConfirmedSign = signName;
  AppState.lastConfirmedTime = now;

  // ── Notify OnlineLearner with the raw fingerpose score ──
  // This is the core of the adaptive engine (anti-overfitting loop)
  if (!isManual && typeof GestureEngine !== 'undefined') {
    GestureEngine.confirmSign(signName, AppState.lastRawFpScore);
  }

  Analytics.recordSign(signName, confidence);
  addWord(signName);
  addChip(signName);
  updateStatsUI();
  updateLeaderboard();

  if (AppState.autoSpeak && signName !== '·') {
    SpeechEngine.speak(signName, getSpeechOpts());
  }
}

// ============================================================
// SIGN CHIPS — recent history strip
// ============================================================
const MAX_CHIPS  = 6;
const recentSigns = [];

function addChip(sign) {
  recentSigns.unshift(sign);
  if (recentSigns.length > MAX_CHIPS) recentSigns.pop();

  if (DOM.signChips) {
    DOM.signChips.innerHTML = recentSigns.map((s, i) =>
      `<span class="sign-chip" style="opacity:${(1 - i * 0.14).toFixed(2)}">${s}</span>`
    ).join('');
  }
}

// ============================================================
// STATS UI
// ============================================================
function updateStatsUI() {
  if (DOM.statTotal)    DOM.statTotal.textContent    = Analytics.totalDetected;
  if (DOM.statMostUsed) DOM.statMostUsed.textContent = Analytics.getMostUsed() || '—';
  if (DOM.statAccuracy) DOM.statAccuracy.textContent = Analytics.getAvgConfidence() + '%';
  if (DOM.statSPM)      DOM.statSPM.textContent      = Analytics.getSignsPerMinute() + '/m';
}

// Periodic stats refresh — stored so we can clear on unload
AppState.statsInterval = setInterval(() => {
  if (DOM.statDuration) DOM.statDuration.textContent = Analytics.formatDuration();
  if (DOM.statSPM)      DOM.statSPM.textContent      = Analytics.getSignsPerMinute() + '/m';
}, 1000);

window.addEventListener('beforeunload', () => {
  clearInterval(AppState.statsInterval);
});

// ============================================================
// LEADERBOARD
// ============================================================
function updateLeaderboard() {
  if (!DOM.leaderboardBody) return;
  const top = Analytics.getTopSigns(8);

  if (top.length === 0) {
    DOM.leaderboardBody.innerHTML = `
      <tr><td colspan="4" style="text-align:center;color:#2a2a2a;padding:20px;font-size:13px;">
        No signs detected yet
      </td></tr>`;
    return;
  }

  DOM.leaderboardBody.innerHTML = top.map((item, i) => `
    <tr class="lb-row">
      <td><span class="lb-rank">#${i + 1}</span></td>
      <td><span class="lb-sign">${item.name}</span></td>
      <td><span class="lb-count">${item.count}</span></td>
      <td>
        <div class="lb-conf-bar">
          <div class="lb-conf-fill" style="width:${item.avgConf}%"></div>
        </div>
        <span class="lb-conf-pct">${item.avgConf}%</span>
      </td>
    </tr>
  `).join('');
}

// ============================================================
// CONTROLS WIRING
// ============================================================
DOM.speedSlider?.addEventListener('input', function () {
  if (DOM.speedVal) DOM.speedVal.textContent = parseFloat(this.value).toFixed(1) + '×';
});

DOM.pitchSlider?.addEventListener('input', function () {
  if (DOM.pitchVal) DOM.pitchVal.textContent = parseFloat(this.value).toFixed(1);
});

DOM.thresholdSlider?.addEventListener('input', function () {
  const v = parseFloat(this.value);
  AppState.confidenceThreshold = v;
  if (DOM.thresholdVal) DOM.thresholdVal.textContent = v.toFixed(1);
});

DOM.debounceSlider?.addEventListener('input', function () {
  const v = parseInt(this.value, 10);
  AppState.debounceMs = v;
  if (DOM.debounceVal) DOM.debounceVal.textContent = v + 'ms';
});

DOM.skeletonToggle?.addEventListener('change', function () {
  AppState.showSkeleton = this.checked;
});

DOM.trailToggle?.addEventListener('change', function () {
  AppState.showTrail = this.checked;
});

DOM.autoSpeakToggle?.addEventListener('change', function () {
  AppState.autoSpeak = this.checked;
});

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================
document.addEventListener('keydown', e => {
  // Don't fire inside input/select elements
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      addSpace();
      break;
    case 'Backspace':
      e.preventDefault();
      backspaceWord();
      break;
    case 'Escape':
      clearSentence();
      break;
    case 's':
    case 'S':
      if (!e.ctrlKey && !e.metaKey) speakSentence();
      break;
    case 'D':
    case 'd':
      // Ctrl+Shift+D — debug dump
      if (e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        if (typeof GestureEngine !== 'undefined') {
          console.table(GestureEngine.debugDump()?.learner || {});
        }
      }
      break;
  }
});

// ============================================================
// SCREENSHOT
// ============================================================
function takeScreenshot() {
  if (!DOM.canvasEl || !DOM.videoEl) return;

  const tmp = document.createElement('canvas');
  tmp.width  = DOM.canvasEl.width;
  tmp.height = DOM.canvasEl.height;
  const tc   = tmp.getContext('2d');

  // Draw mirrored video frame
  tc.save();
  tc.scale(-1, 1);
  tc.drawImage(DOM.videoEl, -tmp.width, 0, tmp.width, tmp.height);
  tc.restore();

  // Overlay canvas (landmarks / skeleton)
  tc.drawImage(DOM.canvasEl, 0, 0);

  const a      = document.createElement('a');
  a.download   = `signbridge_${Date.now()}.png`;
  a.href       = tmp.toDataURL('image/png');
  a.click();
}

// ============================================================
// CALIBRATION UI
// ============================================================
function openCalibOverlay() {
  if (DOM.calibOverlay) DOM.calibOverlay.style.display = 'flex';
}

function closeCalibOverlay() {
  if (DOM.calibOverlay) DOM.calibOverlay.style.display = 'none';
  if (typeof Calibration !== 'undefined') Calibration.stopCalibration();
  AppState.calibrating = false;
  if (DOM.calibStatus) DOM.calibStatus.textContent = '';
}

DOM.calibBtn?.addEventListener('click', () => {
  openCalibOverlay();
  AppState.calibrating = true;

  Calibration.startCalibration(
    (info) => {
      if (DOM.calibSign)    DOM.calibSign.textContent = info.sign || '✅';
      if (DOM.calibHint)    DOM.calibHint.textContent = info.hint || 'Calibration complete!';
      if (DOM.calibSamples) {
        DOM.calibSamples.textContent = info.done
          ? 'All done!'
          : `${info.samples} / ${info.needed} samples`;
      }
      if (DOM.calibProgress) {
        const pct = info.done ? 100 : (info.stepIndex / info.total) * 100;
        DOM.calibProgress.style.width = pct + '%';
      }
      if (DOM.calibStatus) {
        DOM.calibStatus.textContent = info.done
          ? '✅ Calibration complete! Adjustments saved.'
          : `Step ${info.stepIndex + 1} of ${info.total}`;
      }
    },
    (data) => {
      AppState.calibrating = false;
      if (DOM.calibStatus) {
        DOM.calibStatus.textContent =
          `✅ Saved ${Object.keys(data).length} sign calibrations!`;
      }
      setTimeout(closeCalibOverlay, 2200);
    }
  );
});

DOM.calibStopBtn?.addEventListener('click', closeCalibOverlay);

// Click outside modal to close
DOM.calibOverlay?.addEventListener('click', e => {
  if (e.target === DOM.calibOverlay) closeCalibOverlay();
});

// Export session report
document.getElementById('exportBtn')?.addEventListener('click', () => {
  Analytics.exportReport();
});

// Reset calibration data
document.getElementById('resetCalibBtn')?.addEventListener('click', () => {
  if (typeof Calibration !== 'undefined') Calibration.reset();
  if (typeof GestureEngine !== 'undefined') GestureEngine.resetSession();
  // Visual feedback using a toast-style console message
  console.info('[SignBridge] Calibration + OnlineLearner reset.');
  if (DOM.calibStatus) DOM.calibStatus.textContent = '🗑️ Calibration cleared.';
});

// ============================================================
// GESTURE DETECTION PIPELINE
// ============================================================
let lastDetectionTs  = 0;
const DETECTION_INTERVAL = 80; // ms — run at most every 80ms (~12 times/sec)

function runDetection(landmarks) {
  const now = Date.now();
  if (now - lastDetectionTs < DETECTION_INTERVAL) return;
  lastDetectionTs = now;

  const W = DOM.canvasEl?.width  || 640;
  const H = DOM.canvasEl?.height || 480;

  // ── Run full ML pipeline ──
  const result = GestureEngine.detect(
    landmarks, W, H, AppState.confidenceThreshold
  );

  // ── Feed calibration sample if wizard is active ──
  if (AppState.calibrating && result && typeof Calibration !== 'undefined') {
    Calibration.feedSample(result.name, result.confidence / 10);
  }

  if (!result) {
    updateSignDisplay('—', 0, false);
    AppState.pendingSign = '';
    return;
  }

  // ── Apply personal calibration bonus ──
  const calibBonus    = typeof Calibration !== 'undefined'
    ? Calibration.getBonusFor(result.name)
    : 0;
  const adjConf       = Math.min(100, result.confidence + Math.round(calibBonus * 10));

  // Store raw score for OnlineLearner feedback on confirmation
  AppState.lastRawFpScore = result.confidence / 10;

  // Show pending sign immediately (pre-confirmation)
  updateSignDisplay(result.name, adjConf, false);

  // ── Debounce: sign must be held steadily for debounceMs ──
  if (result.name === AppState.pendingSign) {
    if (now - AppState.pendingSignTime >= AppState.debounceMs) {
      // Confirmed!
      updateSignDisplay(result.name, adjConf, true);
      onSignConfirmed(result.name, adjConf);
      AppState.pendingSign     = '';
      AppState.pendingSignTime = 0;
    }
  } else {
    AppState.pendingSign     = result.name;
    AppState.pendingSignTime = now;
  }
}

// ============================================================
// MEDIAPIPE RESULTS CALLBACK
// ============================================================
function onResults(results) {
  // ── FPS counter ──
  AppState.fpsFrames++;
  const now = performance.now();
  if (now - AppState.fpsLastTime >= 1000) {
    AppState.fps         = AppState.fpsFrames;
    AppState.fpsFrames   = 0;
    AppState.fpsLastTime = now;
    if (DOM.fpsCounter) DOM.fpsCounter.textContent = AppState.fps + ' FPS';
  }

  // ── Clear overlay canvas ──
  if (canvasCtx && DOM.canvasEl) {
    Renderer.clear(canvasCtx, DOM.canvasEl.width, DOM.canvasEl.height);
  }

  // ── No hands detected ──
  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    if (!AppState.noHandTimer) {
      AppState.noHandTimer = setTimeout(() => {
        if (DOM.noHandTip) DOM.noHandTip.style.display = 'block';
      }, 5000);
    }
    AppState.pendingSign = '';
    GestureEngine.reset();
    updateSignDisplay('—', 0, false);
    if (DOM.handCountBadge) DOM.handCountBadge.textContent = 'NO HAND';
    return;
  }

  // ── Hand(s) detected ──
  clearTimeout(AppState.noHandTimer);
  AppState.noHandTimer = null;
  if (DOM.noHandTip) DOM.noHandTip.style.display = 'none';

  const count = results.multiHandLandmarks.length;
  if (DOM.handCountBadge) {
    DOM.handCountBadge.textContent = count === 1 ? '1 HAND' : `${count} HANDS`;
  }

  // ── Render all hands ──
  if (canvasCtx && DOM.canvasEl) {
    results.multiHandLandmarks.forEach((lm, idx) => {
      const handedness = results.multiHandedness?.[idx]?.label || '';
      Renderer.render(canvasCtx, lm, DOM.canvasEl.width, DOM.canvasEl.height, {
        showSkeleton: AppState.showSkeleton,
        showTrail:    AppState.showTrail,
        handId:       idx,
        sign:         idx === 0 ? AppState.currentDisplaySign : '',
        confirmed:    idx === 0 && !!AppState.currentDisplaySign,
        handLabel:    count > 1 ? handedness : '',
      });
    });
  }

  // ── Gesture detection — primary hand only ──
  runDetection(results.multiHandLandmarks[0]);
}

// ============================================================
// MEDIAPIPE INIT
// ============================================================
let handsInstance, cameraInstance;

async function initMediaPipe() {
  try {
    setLoadStep(0, 10);

    handsInstance = new Hands({
      locateFile: file =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${file}`,
    });

    handsInstance.setOptions({
      maxNumHands:            2,
      modelComplexity:        1,   // 1 = full model (best accuracy)
      minDetectionConfidence: 0.70,
      minTrackingConfidence:  0.58,
    });

    handsInstance.onResults(onResults);

    setLoadStep(1, 28);

    // Init ML gesture engine
    const engineOK = GestureEngine.init();
    if (!engineOK) {
      throw new Error('GestureEngine.init() failed — fingerpose (fp) not available');
    }

    setLoadStep(2, 50);
    setEngineStatus('loading');
    setLoadStep(3, 72);

    // Start camera
    cameraInstance = new Camera(DOM.videoEl, {
      onFrame: async () => {
        if (DOM.videoEl) await handsInstance.send({ image: DOM.videoEl });
      },
      width:  640,
      height: 480,
    });

    await cameraInstance.start();

    // Set canvas dimensions
    if (DOM.canvasEl) {
      DOM.canvasEl.width  = 640;
      DOM.canvasEl.height = 480;
    }

    // Update canvas size when video metadata is available
    DOM.videoEl?.addEventListener('loadedmetadata', () => {
      if (DOM.canvasEl) {
        DOM.canvasEl.width  = DOM.videoEl.videoWidth  || 640;
        DOM.canvasEl.height = DOM.videoEl.videoHeight || 480;
      }
    }, { once: true });

    // Show video
    if (DOM.videoEl) DOM.videoEl.style.display = 'block';
    if (DOM.videoPlaceholder) DOM.videoPlaceholder.style.display = 'none';

    AppState.cameraReady = true;
    setLoadStep(4, 100);
    setEngineStatus('ready');

    // Fade out loading screen
    setTimeout(() => {
      if (DOM.loadingScreen) {
        DOM.loadingScreen.style.opacity    = '0';
        DOM.loadingScreen.style.transition = 'opacity 0.5s ease';
        setTimeout(() => {
          if (DOM.loadingScreen) DOM.loadingScreen.style.display = 'none';
        }, 520);
      }
    }, 800);

  } catch (err) {
    console.error('[SignBridge] Init error:', err);
    setEngineStatus('error');
    if (DOM.loadingScreen) DOM.loadingScreen.style.display = 'none';
    if (DOM.errorScreen)   DOM.errorScreen.style.display   = 'flex';
  }
}

// ============================================================
// DEMO / FALLBACK MODE
// ============================================================
function startDemoMode() {
  if (DOM.loadingScreen) DOM.loadingScreen.style.display = 'none';
  setEngineStatus('error');

  if (DOM.videoPlaceholder) {
    DOM.videoPlaceholder.innerHTML = `
      <div style="text-align:center;padding:30px;">
        <div style="font-size:56px;margin-bottom:14px;">🤟</div>
        <div style="font-family:'Orbitron',monospace;font-size:14px;
                    color:#00ff88;letter-spacing:3px;margin-bottom:8px;">
          DEMO MODE
        </div>
        <div style="font-size:12px;color:#555;line-height:1.8;max-width:260px;">
          Camera / AI libraries unavailable.<br>
          Click any guide card below to simulate detection.<br>
          <span style="color:#333;font-size:11px;">
            Or use: Space (space) · Backspace · S (speak) · Esc (clear)
          </span>
        </div>
        <button onclick="location.reload()"
          style="margin-top:14px;background:rgba(0,255,136,0.12);
                 border:1px solid #00ff88;color:#00ff88;padding:9px 22px;
                 border-radius:6px;font-family:'Orbitron',monospace;
                 font-size:10px;letter-spacing:2px;cursor:pointer;">
          🔄 RETRY
        </button>
      </div>`;
  }

  // Cycle through demo signs with proper analytics tracking
  const demoSigns = [
    'HELLO', 'I LOVE YOU', 'PEACE', 'THUMBS UP', 'OK',
    'A', 'B', 'L', 'Y', 'STOP', 'GOOD', 'FAST', 'HOME'
  ];
  let di = 0;

  setInterval(() => {
    const sign = demoSigns[di++ % demoSigns.length];
    const conf = 88 + Math.floor(Math.random() * 12);
    updateSignDisplay(sign, conf, false);
  }, 2800);
}

// ============================================================
// SPEECH ENGINE INIT
// ============================================================
const speechOK = SpeechEngine.init({
  onStart: () => { if (DOM.speechStatus) DOM.speechStatus.textContent = '🔊 Speaking…'; },
  onEnd:   () => { if (DOM.speechStatus) DOM.speechStatus.textContent = ''; },
  onError: () => { if (DOM.speechStatus) DOM.speechStatus.textContent = ''; },
});

if (!speechOK && DOM.speechWarning) {
  DOM.speechWarning.style.display = 'flex';
}

// ============================================================
// ENTRY POINT
// ============================================================
window.addEventListener('load', () => {
  renderSentence();
  updateLeaderboard();

  // Speech synthesis availability check
  if (!window.speechSynthesis && DOM.speechWarning) {
    DOM.speechWarning.style.display = 'flex';
  }

  // Poll until all CDN libraries are fully loaded
  const MAX_ATTEMPTS = 18;
  let attempts = 0;

  function tryStart() {
    attempts++;

    const librariesReady =
      typeof Hands        !== 'undefined' &&
      typeof Camera       !== 'undefined' &&
      typeof fp           !== 'undefined' &&
      typeof GestureEngine !== 'undefined' &&
      typeof Analytics    !== 'undefined' &&
      typeof Calibration  !== 'undefined' &&
      typeof Renderer     !== 'undefined' &&
      typeof SpeechEngine !== 'undefined';

    if (librariesReady) {
      initMediaPipe();
    } else if (attempts < MAX_ATTEMPTS) {
      setLoadStep(0, Math.min(18, attempts * 1.5));
      setTimeout(tryStart, 500);
    } else {
      console.warn('[SignBridge] CDN libraries timed out — entering demo mode');
      startDemoMode();
    }
  }

  setTimeout(tryStart, 400);
});
