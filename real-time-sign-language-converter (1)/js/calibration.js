/* ============================================================
   SignBridge — User Calibration Module
   
   Allows the user to:
   1. Run a guided sign-by-sign calibration sequence
   2. Store their personal threshold per-sign in localStorage
   3. Inject per-sign confidence bonuses into the engine output
   4. Reset calibration data
   ============================================================ */

'use strict';

const Calibration = (() => {

  const STORAGE_KEY = 'signbridge_calibration_v1';

  // ── Calibration sequence (subset of signs) ──
  const CALIB_SEQUENCE = [
    { sign: 'A',          hint: 'Make a fist. Thumb rests beside index finger.' },
    { sign: 'B',          hint: '4 fingers straight up, thumb tucked across palm.' },
    { sign: 'L',          hint: 'Index finger up, thumb pointing sideways. L-shape.' },
    { sign: 'THUMBS UP',  hint: 'Fist with thumb pointing straight up.' },
    { sign: 'PEACE',      hint: 'Index and middle finger up, spread in a V.' },
    { sign: 'I LOVE YOU', hint: 'Thumb, index, and pinky extended.' },
    { sign: 'HELLO',      hint: 'Open palm, all fingers spread, facing camera.' },
    { sign: 'STOP',       hint: 'All five fingers straight up, flat open palm.' },
    { sign: 'OK',         hint: 'Thumb and index finger form a circle.' },
    { sign: 'Y',          hint: 'Thumb and pinky extended, other fingers curled.' },
  ];

  // Internal state
  let data        = {}; // sign → { bonus: 0, samples: [] }
  let isRunning   = false;
  let stepIndex   = 0;
  let sampleBuf   = [];
  let onUpdate    = null; // UI callback(step, total, sign, hint, samples)
  let onComplete  = null; // callback()
  const SAMPLES_NEEDED = 15;

  /** Load saved calibration from localStorage */
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) data = JSON.parse(raw);
    } catch(e) { data = {}; }
  }

  /** Persist calibration to localStorage */
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch(e) {}
  }

  /** Start guided calibration sequence */
  function startCalibration(updateCb, completeCb) {
    if (isRunning) return;
    load();
    isRunning   = true;
    stepIndex   = 0;
    sampleBuf   = [];
    onUpdate    = updateCb   || null;
    onComplete  = completeCb || null;
    _notifyUpdate();
  }

  /** Stop / cancel calibration */
  function stopCalibration() {
    isRunning = false;
    stepIndex = 0;
    sampleBuf = [];
  }

  /** Called from app.js with each raw detection result during calibration */
  function feedSample(detectedName, rawScore) {
    if (!isRunning) return;

    const expected = CALIB_SEQUENCE[stepIndex].sign;
    if (detectedName === expected && rawScore > 5) {
      sampleBuf.push(rawScore);
      _notifyUpdate();

      if (sampleBuf.length >= SAMPLES_NEEDED) {
        _commitStep();
      }
    }
  }

  /** Commit the current step's calibration data and advance */
  function _commitStep() {
    const sign = CALIB_SEQUENCE[stepIndex].sign;
    const avg  = sampleBuf.reduce((a,b) => a+b, 0) / sampleBuf.length;

    // Compute bonus: how far user's average is from the expected 8.5
    // If user typically scores 7.5 for this sign, bonus = +1.0
    const bonus = Math.max(-1.5, Math.min(1.5, 8.5 - avg));
    data[sign] = { bonus, avg, samples: sampleBuf.length };

    sampleBuf = [];
    stepIndex++;

    if (stepIndex >= CALIB_SEQUENCE.length) {
      isRunning = false;
      save();
      if (onComplete) onComplete(data);
    } else {
      _notifyUpdate();
    }
  }

  function _notifyUpdate() {
    if (!onUpdate) return;
    const step = CALIB_SEQUENCE[stepIndex];
    onUpdate({
      stepIndex,
      total:    CALIB_SEQUENCE.length,
      sign:     step?.sign,
      hint:     step?.hint,
      samples:  sampleBuf.length,
      needed:   SAMPLES_NEEDED,
      done:     !isRunning && stepIndex >= CALIB_SEQUENCE.length,
    });
  }

  /** Get confidence bonus for a sign (returns 0 if not calibrated) */
  function getBonusFor(sign) {
    return data[sign]?.bonus || 0;
  }

  /** Apply calibration bonus to a raw fingerpose score */
  function applyBonus(sign, rawScore) {
    return rawScore + getBonusFor(sign);
  }

  /** Reset all calibration data */
  function reset() {
    data = {};
    try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
  }

  /** Is calibration complete for a given sign? */
  function isCalibrated(sign) { return data.hasOwnProperty(sign); }

  /** How many signs have been calibrated */
  function calibratedCount() { return Object.keys(data).length; }

  /** Is the guided sequence currently running? */
  function running() { return isRunning; }

  /** Currently expected sign during calibration */
  function currentSign() {
    return isRunning ? CALIB_SEQUENCE[stepIndex]?.sign : null;
  }

  // Auto-load on module init
  load();

  return {
    startCalibration,
    stopCalibration,
    feedSample,
    getBonusFor,
    applyBonus,
    reset,
    isCalibrated,
    calibratedCount,
    running,
    currentSign,
    CALIB_SEQUENCE,
    get data() { return { ...data }; },
  };
})();
