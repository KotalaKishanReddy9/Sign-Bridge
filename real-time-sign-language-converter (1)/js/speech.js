/* ============================================================
   SignBridge — Speech Synthesis Engine v2
   
   Features:
   - Voice priority: neural > premium > standard
   - Per-language voice caching
   - Utterance queue with cancellation
   - Phonetic expansion (abbreviations → full words)
   - Event callbacks: onStart, onEnd, onError
   ============================================================ */

'use strict';

const SpeechEngine = (() => {
  const synth = window.speechSynthesis;

  // Internal state
  let voices      = [];
  let voiceCache  = {}; // lang → best voice
  let callbacks   = { onStart: null, onEnd: null, onError: null };
  let initialized = false;

  // ── Phonetic map: sign name → what to actually speak ──
  const PHONETIC_MAP = {
    'A': 'A', 'B': 'B', 'C': 'C', 'D': 'D', 'E': 'E',
    'F': 'F', 'G': 'G', 'H': 'H', 'I': 'I', 'J': 'J',
    'K': 'K', 'L': 'L', 'M': 'M', 'N': 'N', 'O': 'O',
    'P': 'P', 'Q': 'Q', 'R': 'R', 'S': 'S', 'T': 'T',
    'U': 'U', 'V': 'V', 'W': 'W', 'X': 'X', 'Y': 'Y',
    'Z': 'Z',
    'I LOVE YOU': 'I love you',
    'THUMBS UP':  'Thumbs up',
    'THUMBS DOWN':'Thumbs down',
    'CALL ME':    'Call me',
    'WAIT':       'Wait',
    'MORE':       'More',
    '·':          '', // space character — speak nothing
  };

  /** Load available voices, score and cache best per language */
  function loadVoices() {
    if (!synth) return;
    const raw = synth.getVoices();
    if (raw.length === 0) return; // not ready yet

    voices = raw;
    voiceCache = {};

    // Score voices: neural/enhanced > premium > standard, local > remote
    function scoreVoice(v) {
      let s = 0;
      const n = v.name.toLowerCase();
      if (n.includes('neural') || n.includes('enhanced')) s += 40;
      if (n.includes('premium') || n.includes('wavenet'))  s += 30;
      if (n.includes('siri') || n.includes('google'))      s += 20;
      if (v.localService) s += 10;
      return s;
    }

    const byLang = {};
    for (const v of voices) {
      const lang = v.lang;
      if (!byLang[lang]) byLang[lang] = [];
      byLang[lang].push({ v, score: scoreVoice(v) });
    }

    for (const [lang, arr] of Object.entries(byLang)) {
      arr.sort((a, b) => b.score - a.score);
      voiceCache[lang] = arr[0].v;
    }
  }

  /**
   * Find best voice for a given lang code (e.g. 'en-US')
   * Falls back to partial match (e.g. 'en') then any English.
   */
  function bestVoice(lang) {
    if (voiceCache[lang]) return voiceCache[lang];

    const base = lang.split('-')[0];
    // Try exact lang code first
    const exact = voices.find(v => v.lang === lang);
    if (exact) return exact;
    // Try partial
    const partial = voices.find(v => v.lang.startsWith(base));
    return partial || null;
  }

  /**
   * Expand sign name → speakable text using phonetic map.
   * Falls back to title-cased original.
   */
  function expand(text) {
    if (PHONETIC_MAP.hasOwnProperty(text)) {
      return PHONETIC_MAP[text];
    }
    // Title-case multi-word signs like "I LOVE YOU"
    return text.split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  /** Initialise engine — must be called once. Returns bool. */
  function init(cb = {}) {
    if (!synth) {
      console.warn('[Speech] speechSynthesis not supported');
      return false;
    }
    callbacks = { onStart: cb.onStart || null, onEnd: cb.onEnd || null, onError: cb.onError || null };

    loadVoices();
    if (synth.onvoiceschanged !== undefined) {
      synth.onvoiceschanged = loadVoices;
    }
    // Chrome sometimes needs a second load
    setTimeout(loadVoices, 500);
    initialized = true;
    return true;
  }

  /**
   * Speak text with given options.
   * @param {string} rawText  - sign name or sentence
   * @param {Object} opts     - { lang, rate, pitch, expand }
   */
  function speak(rawText, opts = {}) {
    if (!synth || !rawText) return;

    // Expand abbreviation unless caller opts out
    const text = (opts.expand === false) ? rawText : expand(rawText);
    if (!text || text.trim() === '') return;

    // Cancel current speech
    synth.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang  = opts.lang  || 'en-US';
    utter.rate  = Math.max(0.1, Math.min(10, opts.rate  || 1.0));
    utter.pitch = Math.max(0,   Math.min(2,  opts.pitch || 1.0));
    utter.volume = opts.volume || 1.0;

    const voice = bestVoice(utter.lang);
    if (voice) utter.voice = voice;

    utter.onstart = () => { if (callbacks.onStart) callbacks.onStart(text); };
    utter.onend   = () => { if (callbacks.onEnd)   callbacks.onEnd(text);   };
    utter.onerror = (e) => {
      console.warn('[Speech] Error:', e.error);
      if (callbacks.onError) callbacks.onError(e);
      if (callbacks.onEnd)   callbacks.onEnd('');
    };

    // Chrome bug: speech sometimes hangs — set a safety timeout
    const safetyTimer = setTimeout(() => synth.cancel(), 8000);
    utter.onend = () => {
      clearTimeout(safetyTimer);
      if (callbacks.onEnd) callbacks.onEnd(text);
    };

    synth.speak(utter);
  }

  /** Speak the full sentence array as a single utterance */
  function speakSentence(words, opts = {}) {
    // Join words but skip space markers
    const text = words.filter(w => w !== '·').join(' ');
    speak(text, { ...opts, expand: false });
  }

  /** Stop all speech immediately */
  function cancel() { if (synth) synth.cancel(); }

  /** Is speech currently playing? */
  function isSpeaking() { return synth ? synth.speaking : false; }

  /** Return all loaded voice objects */
  function getVoices() { return voices; }

  /** Return voices available for a specific language */
  function getVoicesForLang(lang) {
    const base = lang.split('-')[0];
    return voices.filter(v => v.lang === lang || v.lang.startsWith(base));
  }

  return {
    init, speak, speakSentence, cancel,
    isSpeaking, getVoices, getVoicesForLang,
    get isInitialized() { return initialized; }
  };
})();
