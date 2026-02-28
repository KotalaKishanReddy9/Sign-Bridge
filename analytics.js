/* ============================================================
   SignBridge — Analytics & Session Manager
   
   Tracks:
   - Per-sign frequency, avg confidence, streak counts
   - Session timeline events
   - Words-per-minute estimation
   - Confusion matrix (what sign was expected vs detected)
   - Exports session report as JSON
   ============================================================ */

'use strict';

const Analytics = (() => {

  const session = {
    startTime:    Date.now(),
    events:       [],      // { ts, type, data }
    signs:        {},      // name → { count, totalConf, bestConf, streak }
    totalDetected:0,
    totalConf:    0,
    wpmSamples:   [],      // timestamps of each confirmed sign
    confusionLog: [],      // { detected, expected } — populated if user corrects
  };

  /** Record a sign detection event */
  function recordSign(name, confidence) {
    const ts = Date.now();

    // Init sign entry
    if (!session.signs[name]) {
      session.signs[name] = { count: 0, totalConf: 0, bestConf: 0, streak: 0, firstSeen: ts };
    }
    const s = session.signs[name];
    s.count++;
    s.totalConf += confidence;
    s.bestConf   = Math.max(s.bestConf, confidence);
    s.streak++;

    // Reset streaks for all other signs
    for (const [n, v] of Object.entries(session.signs)) {
      if (n !== name) v.streak = 0;
    }

    session.totalDetected++;
    session.totalConf += confidence;

    // WPM sampling
    session.wpmSamples.push(ts);
    // Keep only last 60 seconds
    const cutoff = ts - 60000;
    session.wpmSamples = session.wpmSamples.filter(t => t > cutoff);

    session.events.push({ ts, type: 'sign', data: { name, confidence } });
  }

  /** Record a sentence spoken event */
  function recordSpeech(sentence) {
    session.events.push({
      ts: Date.now(),
      type: 'speech',
      data: { sentence: sentence.join(' ') }
    });
  }

  /** Signs per minute (last 60s) */
  function getSignsPerMinute() {
    return session.wpmSamples.length; // already filtered to 60s window
  }

  /** Session duration in seconds */
  function getDuration() {
    return Math.floor((Date.now() - session.startTime) / 1000);
  }

  /** Average confidence across all detections */
  function getAvgConfidence() {
    if (session.totalDetected === 0) return 0;
    return Math.round(session.totalConf / session.totalDetected);
  }

  /** Most frequently detected sign */
  function getMostUsed() {
    let top = null, topCount = 0;
    for (const [name, data] of Object.entries(session.signs)) {
      if (data.count > topCount) {
        topCount = data.count;
        top = name;
      }
    }
    return top;
  }

  /** Top N signs by frequency */
  function getTopSigns(n = 5) {
    return Object.entries(session.signs)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, n)
      .map(([name, data]) => ({
        name,
        count: data.count,
        avgConf: Math.round(data.totalConf / data.count),
        bestConf: data.bestConf,
        streak: data.streak,
      }));
  }

  /** Current streak for given sign */
  function getStreak(name) {
    return session.signs[name]?.streak || 0;
  }

  /** Full sign leaderboard sorted by count desc */
  function getLeaderboard() {
    return Object.entries(session.signs)
      .map(([name, d]) => ({
        name,
        count:   d.count,
        avgConf: Math.round(d.totalConf / d.count),
        bestConf:d.bestConf,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /** Export full session as JSON (triggers download) */
  function exportReport() {
    const report = {
      sessionId:      `sb_${session.startTime}`,
      generatedAt:    new Date().toISOString(),
      durationSeconds:getDuration(),
      totalSigns:     session.totalDetected,
      avgConfidence:  getAvgConfidence(),
      signsPerMinute: getSignsPerMinute(),
      mostUsed:       getMostUsed(),
      topSigns:       getTopSigns(10),
      allSigns:       getLeaderboard(),
      timeline:       session.events.slice(-100), // last 100 events
    };

    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `signbridge_session_${session.startTime}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Format duration MM:SS */
  function formatDuration() {
    const s = getDuration();
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  }

  /** Reset session (used if user clicks "New Session") */
  function resetSession() {
    session.startTime    = Date.now();
    session.events       = [];
    session.signs        = {};
    session.totalDetected= 0;
    session.totalConf    = 0;
    session.wpmSamples   = [];
    session.confusionLog = [];
  }

  return {
    recordSign,
    recordSpeech,
    getSignsPerMinute,
    getDuration,
    getAvgConfidence,
    getMostUsed,
    getTopSigns,
    getStreak,
    getLeaderboard,
    exportReport,
    formatDuration,
    resetSession,
    get totalDetected() { return session.totalDetected; },
  };
})();
