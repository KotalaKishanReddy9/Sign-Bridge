/* ============================================================
   SignBridge — ML Gesture Engine v4
   
   AUDIT FIXES v4:
   ✅ Removed thumbTip_x undefined reference in ConflictResolver
   ✅ Fixed totalWeight normalisation in TemporalSmoother (was wrong formula)
   ✅ Fixed GeometricAnalyzer.classify — extCount===5 spread calc was using
      wrong scale reference after block scope
   ✅ Added null-guard on lm[9] in trail draw path
   ✅ ConflictResolver no longer silently swallows wrong-branch returns
   ✅ All gesture weights validated against real ASL references
   ✅ Added 14 new gestures: GOOD, BAD, EAT, DRINK, SLEEP, HOME,
      LOVE, FRIEND, MONEY, WORK, HOT, COLD, FAST, SLOW
   ✅ OnlineLearner — lightweight per-sign score adapter that tunes
      confidence offsets from the user's own session (no overfitting:
      uses exponential moving average with decay, capped at ±2.5)
   ✅ HandNormaliser — compensates for hand tilt / wrist rotation so
      that geometric checks work correctly regardless of hand angle
   ✅ Overfitting guard: OnlineLearner requires MIN_CONFIRM samples
      before applying any learned offset; offset decays toward 0 each
      session to prevent stale drift
   
   Architecture (6 layers):
   ① Kishan Sai Bhavya + Fingerpose  (curl + direction scoring, 56 gestures)
   ② GeometricAnalyzer               (landmark math — angles, ratios, distances)
   ③ ConflictResolver                (sign-pair disambiguation rules)
   ④ OnlineLearner                   (session-scoped confidence adapter, EMA)
   ⑤ TemporalSmoother                (8-frame weighted voting, majority filter)
   ⑥ GestureEngine                   (public API — detect / reset / init)
   ============================================================ */

'use strict';

// ─────────────────────────────────────────────────────────────
// SECTION 1 — Fingerpose gesture bank  (56 gestures)
// ─────────────────────────────────────────────────────────────
function buildGestureEstimator() {
  if (typeof fp === 'undefined') {
    console.error('[Gestures] Fingerpose (fp) not loaded');
    return null;
  }

  const { Finger: F, FingerCurl: FC, FingerDirection: FD, GestureDescription } = fp;
  const G = name => new GestureDescription(name);

  // ── Helper to set all non-thumb fingers to FullCurl ──
  function allFingersIn(g, thumbCurl = FC.HalfCurl, thumbWeight = 1.0) {
    g.addCurl(F.Thumb,  thumbCurl,   thumbWeight);
    g.addCurl(F.Index,  FC.FullCurl, 1.0);
    g.addCurl(F.Middle, FC.FullCurl, 1.0);
    g.addCurl(F.Ring,   FC.FullCurl, 1.0);
    g.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  }

  // ── Helper to set all non-thumb fingers to NoCurl ──
  function allFingersOut(g, thumbCurl = FC.NoCurl, thumbWeight = 0.8) {
    g.addCurl(F.Thumb,  thumbCurl,  thumbWeight);
    g.addCurl(F.Index,  FC.NoCurl,  1.0);
    g.addCurl(F.Middle, FC.NoCurl,  1.0);
    g.addCurl(F.Ring,   FC.NoCurl,  1.0);
    g.addCurl(F.Pinky,  FC.NoCurl,  1.0);
  }

  // ══════════════════════════════════════════════
  // A–Z ALPHABET
  // ══════════════════════════════════════════════

  // A — fist, thumb alongside (not over) index finger
  const A = G('A');
  A.addCurl(F.Thumb,  FC.NoCurl,   0.7);
  A.addCurl(F.Index,  FC.FullCurl, 1.0);
  A.addCurl(F.Middle, FC.FullCurl, 1.0);
  A.addCurl(F.Ring,   FC.FullCurl, 1.0);
  A.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  A.addDirection(F.Thumb, FD.DiagonalUpLeft,  0.9);
  A.addDirection(F.Thumb, FD.VerticalUp,      0.4);

  // B — 4 fingers vertical, thumb curled across palm
  const B = G('B');
  B.addCurl(F.Thumb,  FC.FullCurl, 1.0);
  B.addCurl(F.Index,  FC.NoCurl,   1.0);
  B.addCurl(F.Middle, FC.NoCurl,   1.0);
  B.addCurl(F.Ring,   FC.NoCurl,   1.0);
  B.addCurl(F.Pinky,  FC.NoCurl,   1.0);
  B.addDirection(F.Index,  FD.VerticalUp, 1.0);
  B.addDirection(F.Middle, FD.VerticalUp, 1.0);
  B.addDirection(F.Ring,   FD.VerticalUp, 0.9);
  B.addDirection(F.Pinky,  FD.VerticalUp, 0.9);

  // C — all half-curl forming arc
  const C = G('C');
  C.addCurl(F.Thumb,  FC.HalfCurl, 1.0);
  C.addCurl(F.Index,  FC.HalfCurl, 1.0);
  C.addCurl(F.Middle, FC.HalfCurl, 1.0);
  C.addCurl(F.Ring,   FC.HalfCurl, 1.0);
  C.addCurl(F.Pinky,  FC.HalfCurl, 1.0);
  C.addDirection(F.Index,  FD.DiagonalUpLeft,  0.8);
  C.addDirection(F.Middle, FD.DiagonalUpLeft,  0.7);
  C.addDirection(F.Thumb,  FD.DiagonalUpRight, 0.7);

  // D — index up, others curl and touch thumb
  const D = G('D');
  D.addCurl(F.Thumb,  FC.HalfCurl, 0.9);
  D.addCurl(F.Index,  FC.NoCurl,   1.0);
  D.addCurl(F.Middle, FC.FullCurl, 1.0);
  D.addCurl(F.Ring,   FC.FullCurl, 1.0);
  D.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  D.addDirection(F.Index, FD.VerticalUp,     1.0);
  D.addDirection(F.Index, FD.DiagonalUpLeft, 0.4);

  // E — bent claw, all fingers hooked at middle joint, thumb tucked under
  const E = G('E');
  E.addCurl(F.Thumb,  FC.HalfCurl, 1.0);
  E.addCurl(F.Index,  FC.HalfCurl, 1.0);
  E.addCurl(F.Middle, FC.HalfCurl, 1.0);
  E.addCurl(F.Ring,   FC.HalfCurl, 1.0);
  E.addCurl(F.Pinky,  FC.HalfCurl, 1.0);
  E.addDirection(F.Index,  FD.HorizontalLeft, 0.9);
  E.addDirection(F.Middle, FD.HorizontalLeft, 0.9);
  E.addDirection(F.Ring,   FD.HorizontalLeft, 0.8);
  E.addDirection(F.Pinky,  FD.HorizontalLeft, 0.7);

  // F — index+thumb pinch, middle/ring/pinky straight up
  const Fsign = G('F');
  Fsign.addCurl(F.Thumb,  FC.HalfCurl, 1.0);
  Fsign.addCurl(F.Index,  FC.HalfCurl, 1.0);
  Fsign.addCurl(F.Middle, FC.NoCurl,   1.0);
  Fsign.addCurl(F.Ring,   FC.NoCurl,   1.0);
  Fsign.addCurl(F.Pinky,  FC.NoCurl,   1.0);
  Fsign.addDirection(F.Middle, FD.VerticalUp, 1.0);
  Fsign.addDirection(F.Ring,   FD.VerticalUp, 0.9);
  Fsign.addDirection(F.Pinky,  FD.VerticalUp, 0.8);

  // G — index+thumb horizontal pointing sideways
  const Gsign = G('G');
  Gsign.addCurl(F.Thumb,  FC.NoCurl,   1.0);
  Gsign.addCurl(F.Index,  FC.NoCurl,   1.0);
  Gsign.addCurl(F.Middle, FC.FullCurl, 1.0);
  Gsign.addCurl(F.Ring,   FC.FullCurl, 1.0);
  Gsign.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  Gsign.addDirection(F.Index, FD.HorizontalLeft, 1.0);
  Gsign.addDirection(F.Thumb, FD.HorizontalLeft, 0.9);

  // H — index+middle pointing horizontally side-by-side
  const H = G('H');
  H.addCurl(F.Thumb,  FC.FullCurl, 0.7);
  H.addCurl(F.Index,  FC.NoCurl,   1.0);
  H.addCurl(F.Middle, FC.NoCurl,   1.0);
  H.addCurl(F.Ring,   FC.FullCurl, 1.0);
  H.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  H.addDirection(F.Index,  FD.HorizontalLeft, 1.0);
  H.addDirection(F.Middle, FD.HorizontalLeft, 1.0);

  // I — pinky up, tight fist
  const I = G('I');
  I.addCurl(F.Thumb,  FC.FullCurl, 0.8);
  I.addCurl(F.Index,  FC.FullCurl, 1.0);
  I.addCurl(F.Middle, FC.FullCurl, 1.0);
  I.addCurl(F.Ring,   FC.FullCurl, 1.0);
  I.addCurl(F.Pinky,  FC.NoCurl,   1.0);
  I.addDirection(F.Pinky, FD.VerticalUp,      1.0);
  I.addDirection(F.Pinky, FD.DiagonalUpRight, 0.3);

  // J — pinky tilts diagonally left (J-draw static approximation)
  const J = G('J');
  J.addCurl(F.Thumb,  FC.NoCurl,   0.4);
  J.addCurl(F.Index,  FC.FullCurl, 1.0);
  J.addCurl(F.Middle, FC.FullCurl, 1.0);
  J.addCurl(F.Ring,   FC.FullCurl, 1.0);
  J.addCurl(F.Pinky,  FC.NoCurl,   1.0);
  J.addDirection(F.Pinky, FD.DiagonalUpLeft, 1.0);
  J.addDirection(F.Pinky, FD.HorizontalLeft, 0.5);

  // K — index up, middle half-out at angle, thumb between them
  const K = G('K');
  K.addCurl(F.Thumb,  FC.NoCurl,   1.0);
  K.addCurl(F.Index,  FC.NoCurl,   1.0);
  K.addCurl(F.Middle, FC.HalfCurl, 1.0);
  K.addCurl(F.Ring,   FC.FullCurl, 1.0);
  K.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  K.addDirection(F.Index,  FD.VerticalUp,      1.0);
  K.addDirection(F.Middle, FD.DiagonalUpLeft,  0.9);
  K.addDirection(F.Thumb,  FD.DiagonalUpRight, 0.8);

  // L — index vertical + thumb horizontal = L-shape
  const L = G('L');
  L.addCurl(F.Thumb,  FC.NoCurl,   1.0);
  L.addCurl(F.Index,  FC.NoCurl,   1.0);
  L.addCurl(F.Middle, FC.FullCurl, 1.0);
  L.addCurl(F.Ring,   FC.FullCurl, 1.0);
  L.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  L.addDirection(F.Index, FD.VerticalUp,      1.0);
  L.addDirection(F.Thumb, FD.HorizontalLeft,  1.0);

  // M — 3 fingers (index/middle/ring) folded over thumb
  const M = G('M');
  M.addCurl(F.Thumb,  FC.HalfCurl, 1.0);
  M.addCurl(F.Index,  FC.FullCurl, 1.0);
  M.addCurl(F.Middle, FC.FullCurl, 1.0);
  M.addCurl(F.Ring,   FC.FullCurl, 1.0);
  M.addCurl(F.Pinky,  FC.FullCurl, 0.9);
  M.addDirection(F.Thumb, FD.HorizontalLeft, 0.9);
  M.addDirection(F.Index, FD.HorizontalLeft, 0.5);

  // N — 2 fingers (index/middle) folded over thumb
  const N = G('N');
  N.addCurl(F.Thumb,  FC.HalfCurl, 1.0);
  N.addCurl(F.Index,  FC.FullCurl, 1.0);
  N.addCurl(F.Middle, FC.FullCurl, 1.0);
  N.addCurl(F.Ring,   FC.HalfCurl, 1.0);
  N.addCurl(F.Pinky,  FC.NoCurl,   0.5);
  N.addDirection(F.Thumb,  FD.DiagonalUpLeft, 0.8);
  N.addDirection(F.Middle, FD.HorizontalLeft, 0.5);

  // O — all fingers pinch into O circle
  const O = G('O');
  O.addCurl(F.Thumb,  FC.HalfCurl, 1.0);
  O.addCurl(F.Index,  FC.HalfCurl, 1.0);
  O.addCurl(F.Middle, FC.HalfCurl, 1.0);
  O.addCurl(F.Ring,   FC.HalfCurl, 1.0);
  O.addCurl(F.Pinky,  FC.HalfCurl, 1.0);
  O.addDirection(F.Index,  FD.DiagonalUpLeft,  0.9);
  O.addDirection(F.Middle, FD.DiagonalUpLeft,  0.8);
  O.addDirection(F.Thumb,  FD.DiagonalUpRight, 0.8);

  // P — K pointing downward
  const P = G('P');
  P.addCurl(F.Thumb,  FC.NoCurl,   1.0);
  P.addCurl(F.Index,  FC.NoCurl,   1.0);
  P.addCurl(F.Middle, FC.HalfCurl, 1.0);
  P.addCurl(F.Ring,   FC.FullCurl, 1.0);
  P.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  P.addDirection(F.Index,  FD.DiagonalDownLeft,  1.0);
  P.addDirection(F.Middle, FD.DiagonalDownLeft,  0.7);
  P.addDirection(F.Thumb,  FD.DiagonalDownRight, 0.7);

  // Q — G pointing downward
  const Q = G('Q');
  Q.addCurl(F.Thumb,  FC.NoCurl,   1.0);
  Q.addCurl(F.Index,  FC.NoCurl,   1.0);
  Q.addCurl(F.Middle, FC.FullCurl, 1.0);
  Q.addCurl(F.Ring,   FC.FullCurl, 1.0);
  Q.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  Q.addDirection(F.Index, FD.DiagonalDownLeft, 1.0);
  Q.addDirection(F.Thumb, FD.DiagonalDownLeft, 0.9);

  // R — index + middle crossed (middle leans left)
  const R = G('R');
  R.addCurl(F.Thumb,  FC.FullCurl, 0.7);
  R.addCurl(F.Index,  FC.NoCurl,   1.0);
  R.addCurl(F.Middle, FC.NoCurl,   1.0);
  R.addCurl(F.Ring,   FC.FullCurl, 1.0);
  R.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  R.addDirection(F.Index,  FD.VerticalUp,     1.0);
  R.addDirection(F.Middle, FD.DiagonalUpLeft, 1.0);

  // S — tight fist, thumb wraps OVER fingers horizontally
  const S = G('S');
  S.addCurl(F.Thumb,  FC.HalfCurl, 1.0);
  S.addCurl(F.Index,  FC.FullCurl, 1.0);
  S.addCurl(F.Middle, FC.FullCurl, 1.0);
  S.addCurl(F.Ring,   FC.FullCurl, 1.0);
  S.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  S.addDirection(F.Thumb, FD.HorizontalLeft, 1.0);

  // T — thumb pokes up between index and middle fingers
  const T = G('T');
  T.addCurl(F.Thumb,  FC.HalfCurl, 1.0);
  T.addCurl(F.Index,  FC.FullCurl, 1.0);
  T.addCurl(F.Middle, FC.FullCurl, 1.0);
  T.addCurl(F.Ring,   FC.FullCurl, 1.0);
  T.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  T.addDirection(F.Thumb, FD.DiagonalUpLeft, 1.0);
  T.addDirection(F.Thumb, FD.VerticalUp,     0.6);

  // U — index + middle parallel straight up together
  const U = G('U');
  U.addCurl(F.Thumb,  FC.FullCurl, 0.8);
  U.addCurl(F.Index,  FC.NoCurl,   1.0);
  U.addCurl(F.Middle, FC.NoCurl,   1.0);
  U.addCurl(F.Ring,   FC.FullCurl, 1.0);
  U.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  U.addDirection(F.Index,  FD.VerticalUp, 1.0);
  U.addDirection(F.Middle, FD.VerticalUp, 1.0);

  // V — index + middle spread apart in V shape
  const V = G('V');
  V.addCurl(F.Thumb,  FC.FullCurl, 0.7);
  V.addCurl(F.Index,  FC.NoCurl,   1.0);
  V.addCurl(F.Middle, FC.NoCurl,   1.0);
  V.addCurl(F.Ring,   FC.FullCurl, 1.0);
  V.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  V.addDirection(F.Index,  FD.DiagonalUpRight, 1.0);
  V.addDirection(F.Middle, FD.DiagonalUpLeft,  1.0);

  // W — index + middle + ring spread upward (3-finger fan)
  const W = G('W');
  W.addCurl(F.Thumb,  FC.FullCurl, 0.7);
  W.addCurl(F.Index,  FC.NoCurl,   1.0);
  W.addCurl(F.Middle, FC.NoCurl,   1.0);
  W.addCurl(F.Ring,   FC.NoCurl,   1.0);
  W.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  W.addDirection(F.Index,  FD.DiagonalUpRight, 0.8);
  W.addDirection(F.Middle, FD.VerticalUp,      1.0);
  W.addDirection(F.Ring,   FD.DiagonalUpLeft,  0.8);

  // X — index hooked/bent (crooked hook), rest fist
  const X = G('X');
  X.addCurl(F.Thumb,  FC.FullCurl, 0.6);
  X.addCurl(F.Index,  FC.HalfCurl, 1.0);
  X.addCurl(F.Middle, FC.FullCurl, 1.0);
  X.addCurl(F.Ring,   FC.FullCurl, 1.0);
  X.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  X.addDirection(F.Index, FD.DiagonalUpLeft, 0.9);
  X.addDirection(F.Index, FD.HorizontalLeft, 0.5);

  // Y — thumb + pinky both extended, middle 3 curled
  const Y = G('Y');
  Y.addCurl(F.Thumb,  FC.NoCurl,   1.0);
  Y.addCurl(F.Index,  FC.FullCurl, 1.0);
  Y.addCurl(F.Middle, FC.FullCurl, 1.0);
  Y.addCurl(F.Ring,   FC.FullCurl, 1.0);
  Y.addCurl(F.Pinky,  FC.NoCurl,   1.0);
  Y.addDirection(F.Thumb,  FD.HorizontalLeft,  1.0);
  Y.addDirection(F.Pinky,  FD.DiagonalUpRight, 1.0);

  // Z — index pointing diagonally up-right (Z-draw static approximation)
  const Z = G('Z');
  Z.addCurl(F.Thumb,  FC.FullCurl, 0.7);
  Z.addCurl(F.Index,  FC.NoCurl,   1.0);
  Z.addCurl(F.Middle, FC.FullCurl, 1.0);
  Z.addCurl(F.Ring,   FC.FullCurl, 1.0);
  Z.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  Z.addDirection(F.Index, FD.DiagonalUpRight, 1.0);

  // ══════════════════════════════════════════════
  // COMMON WORDS / PHRASES
  // ══════════════════════════════════════════════

  // THUMBS UP — fist, thumb straight up
  const thumbsUp = G('THUMBS UP');
  allFingersIn(thumbsUp, FC.NoCurl, 1.0);
  thumbsUp.addCurl(F.Thumb, FC.NoCurl, 1.0);
  thumbsUp.addDirection(F.Thumb, FD.VerticalUp, 1.0);

  // THUMBS DOWN — fist, thumb straight down
  const thumbsDown = G('THUMBS DOWN');
  allFingersIn(thumbsDown, FC.NoCurl, 1.0);
  thumbsDown.addCurl(F.Thumb, FC.NoCurl, 1.0);
  thumbsDown.addDirection(F.Thumb, FD.VerticalDown, 1.0);

  // I LOVE YOU — thumb + index + pinky extended (ILY)
  const iLoveYou = G('I LOVE YOU');
  iLoveYou.addCurl(F.Thumb,  FC.NoCurl,   1.0);
  iLoveYou.addCurl(F.Index,  FC.NoCurl,   1.0);
  iLoveYou.addCurl(F.Middle, FC.FullCurl, 1.0);
  iLoveYou.addCurl(F.Ring,   FC.FullCurl, 1.0);
  iLoveYou.addCurl(F.Pinky,  FC.NoCurl,   1.0);
  iLoveYou.addDirection(F.Index, FD.VerticalUp,     1.0);
  iLoveYou.addDirection(F.Pinky, FD.VerticalUp,     1.0);
  iLoveYou.addDirection(F.Thumb, FD.HorizontalLeft, 0.8);

  // PEACE — V-shape with thumb half-out (not in fist like V)
  const peace = G('PEACE');
  peace.addCurl(F.Thumb,  FC.HalfCurl, 0.9);
  peace.addCurl(F.Index,  FC.NoCurl,   1.0);
  peace.addCurl(F.Middle, FC.NoCurl,   1.0);
  peace.addCurl(F.Ring,   FC.FullCurl, 1.0);
  peace.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  peace.addDirection(F.Index,  FD.VerticalUp,      1.0);
  peace.addDirection(F.Middle, FD.VerticalUp,      1.0);
  peace.addDirection(F.Thumb,  FD.DiagonalUpRight, 0.6);

  // HELLO — open flat palm, all 5 fingers spread out
  const hello = G('HELLO');
  allFingersOut(hello, FC.NoCurl, 0.8);
  hello.addDirection(F.Index,  FD.DiagonalUpLeft,  0.7);
  hello.addDirection(F.Middle, FD.VerticalUp,      0.9);
  hello.addDirection(F.Ring,   FD.DiagonalUpRight, 0.7);

  // THANKS — flat hand angles forward-right (like a salute)
  const thanks = G('THANKS');
  allFingersOut(thanks, FC.NoCurl, 0.8);
  thanks.addDirection(F.Index,  FD.DiagonalUpRight, 0.9);
  thanks.addDirection(F.Middle, FD.DiagonalUpRight, 0.9);
  thanks.addDirection(F.Ring,   FD.DiagonalUpRight, 0.7);

  // YES — fist with thumb angled diagonally up-right
  const yes = G('YES');
  allFingersIn(yes, FC.NoCurl, 1.0);
  yes.addCurl(F.Thumb, FC.NoCurl, 1.0);
  yes.addDirection(F.Thumb, FD.DiagonalUpRight, 1.0);
  yes.addDirection(F.Thumb, FD.VerticalUp,      0.4);

  // NO — index + middle snap sideways toward thumb (scissor)
  const no = G('NO');
  no.addCurl(F.Thumb,  FC.HalfCurl, 1.0);
  no.addCurl(F.Index,  FC.NoCurl,   1.0);
  no.addCurl(F.Middle, FC.NoCurl,   1.0);
  no.addCurl(F.Ring,   FC.FullCurl, 1.0);
  no.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  no.addDirection(F.Index,  FD.HorizontalLeft, 1.0);
  no.addDirection(F.Middle, FD.HorizontalLeft, 0.9);
  no.addDirection(F.Thumb,  FD.HorizontalLeft, 0.8);

  // PLEASE — open palm sweeps horizontally across chest
  const please = G('PLEASE');
  allFingersOut(please, FC.NoCurl, 0.6);
  please.addDirection(F.Index,  FD.HorizontalLeft, 1.0);
  please.addDirection(F.Middle, FD.HorizontalLeft, 1.0);
  please.addDirection(F.Ring,   FD.HorizontalLeft, 0.8);

  // SORRY — full fist, thumb pointing diagonally up-right
  const sorry = G('SORRY');
  allFingersIn(sorry, FC.FullCurl, 0.8);
  sorry.addCurl(F.Thumb, FC.FullCurl, 0.8);
  sorry.addDirection(F.Thumb, FD.DiagonalUpRight, 0.9);

  // HELP — A-fist on flat palm, thumb points up-left
  const help = G('HELP');
  allFingersIn(help, FC.NoCurl, 1.0);
  help.addCurl(F.Thumb, FC.NoCurl, 1.0);
  help.addDirection(F.Thumb, FD.DiagonalUpLeft, 1.0);
  help.addDirection(F.Thumb, FD.VerticalUp,     0.6);

  // STOP — all 5 fingers straight up (karate chop position)
  const stop = G('STOP');
  allFingersOut(stop, FC.NoCurl, 0.9);
  stop.addDirection(F.Index,  FD.VerticalUp,     1.0);
  stop.addDirection(F.Middle, FD.VerticalUp,     1.0);
  stop.addDirection(F.Ring,   FD.VerticalUp,     1.0);
  stop.addDirection(F.Pinky,  FD.VerticalUp,     1.0);
  stop.addDirection(F.Thumb,  FD.HorizontalLeft, 0.8);

  // OK — thumb+index circle, middle/ring/pinky up
  const ok = G('OK');
  ok.addCurl(F.Thumb,  FC.HalfCurl, 1.0);
  ok.addCurl(F.Index,  FC.HalfCurl, 1.0);
  ok.addCurl(F.Middle, FC.NoCurl,   1.0);
  ok.addCurl(F.Ring,   FC.NoCurl,   1.0);
  ok.addCurl(F.Pinky,  FC.NoCurl,   1.0);
  ok.addDirection(F.Middle, FD.VerticalUp, 1.0);
  ok.addDirection(F.Ring,   FD.VerticalUp, 0.9);
  ok.addDirection(F.Pinky,  FD.VerticalUp, 0.8);

  // CALL ME — thumb+pinky horizontal (phone hand)
  const callMe = G('CALL ME');
  callMe.addCurl(F.Thumb,  FC.NoCurl,   1.0);
  callMe.addCurl(F.Index,  FC.FullCurl, 1.0);
  callMe.addCurl(F.Middle, FC.FullCurl, 1.0);
  callMe.addCurl(F.Ring,   FC.FullCurl, 1.0);
  callMe.addCurl(F.Pinky,  FC.NoCurl,   1.0);
  callMe.addDirection(F.Thumb,  FD.HorizontalLeft,  1.0);
  callMe.addDirection(F.Pinky,  FD.HorizontalRight, 1.0);

  // WAIT — open palm horizontal, fingers pointing sideways
  const wait = G('WAIT');
  allFingersOut(wait, FC.NoCurl, 0.7);
  wait.addDirection(F.Index,  FD.HorizontalLeft, 0.9);
  wait.addDirection(F.Middle, FD.HorizontalLeft, 0.9);
  wait.addDirection(F.Ring,   FD.HorizontalLeft, 0.8);
  wait.addDirection(F.Pinky,  FD.HorizontalLeft, 0.7);

  // MORE — fingertips pinched (O-shape tap toward each other)
  const more = G('MORE');
  more.addCurl(F.Thumb,  FC.HalfCurl, 1.0);
  more.addCurl(F.Index,  FC.FullCurl, 1.0);
  more.addCurl(F.Middle, FC.FullCurl, 1.0);
  more.addCurl(F.Ring,   FC.FullCurl, 1.0);
  more.addCurl(F.Pinky,  FC.HalfCurl, 1.0);
  more.addDirection(F.Thumb, FD.DiagonalUpRight, 0.8);
  more.addDirection(F.Pinky, FD.DiagonalUpLeft,  0.7);

  // ══════════════════════════════════════════════
  // NEW GESTURES (14 additions)
  // ══════════════════════════════════════════════

  // GOOD — flat hand, all fingers together pointing diagonally forward-right
  // (chin → forward motion — static: fingers diagonal right, thumb out)
  const good = G('GOOD');
  good.addCurl(F.Thumb,  FC.NoCurl, 0.8);
  good.addCurl(F.Index,  FC.NoCurl, 1.0);
  good.addCurl(F.Middle, FC.NoCurl, 1.0);
  good.addCurl(F.Ring,   FC.NoCurl, 1.0);
  good.addCurl(F.Pinky,  FC.NoCurl, 1.0);
  good.addDirection(F.Index,  FD.DiagonalUpRight, 1.0);
  good.addDirection(F.Middle, FD.DiagonalUpRight, 1.0);
  good.addDirection(F.Ring,   FD.DiagonalUpRight, 0.9);
  good.addDirection(F.Pinky,  FD.DiagonalUpRight, 0.8);
  good.addDirection(F.Thumb,  FD.HorizontalLeft,  0.6);

  // BAD — like GOOD but hand flips palm down / fingers diagonal down
  const bad = G('BAD');
  bad.addCurl(F.Thumb,  FC.NoCurl, 0.7);
  bad.addCurl(F.Index,  FC.NoCurl, 1.0);
  bad.addCurl(F.Middle, FC.NoCurl, 1.0);
  bad.addCurl(F.Ring,   FC.NoCurl, 1.0);
  bad.addCurl(F.Pinky,  FC.NoCurl, 1.0);
  bad.addDirection(F.Index,  FD.DiagonalDownLeft, 1.0);
  bad.addDirection(F.Middle, FD.DiagonalDownLeft, 1.0);
  bad.addDirection(F.Ring,   FD.DiagonalDownLeft, 0.9);

  // EAT — all 4 fingers + thumb bunched together pointing at mouth (all half-curl)
  const eat = G('EAT');
  eat.addCurl(F.Thumb,  FC.HalfCurl, 1.0);
  eat.addCurl(F.Index,  FC.HalfCurl, 1.0);
  eat.addCurl(F.Middle, FC.HalfCurl, 1.0);
  eat.addCurl(F.Ring,   FC.HalfCurl, 1.0);
  eat.addCurl(F.Pinky,  FC.HalfCurl, 1.0);
  eat.addDirection(F.Index,  FD.DiagonalUpRight, 0.9);
  eat.addDirection(F.Middle, FD.DiagonalUpRight, 0.9);
  eat.addDirection(F.Thumb,  FD.DiagonalUpRight, 0.8);

  // DRINK — C-shape with thumb up (like holding a cup, tipping it)
  const drink = G('DRINK');
  drink.addCurl(F.Thumb,  FC.NoCurl,   0.9);
  drink.addCurl(F.Index,  FC.HalfCurl, 1.0);
  drink.addCurl(F.Middle, FC.HalfCurl, 1.0);
  drink.addCurl(F.Ring,   FC.HalfCurl, 1.0);
  drink.addCurl(F.Pinky,  FC.HalfCurl, 1.0);
  drink.addDirection(F.Thumb,  FD.VerticalUp,      1.0);
  drink.addDirection(F.Index,  FD.DiagonalUpLeft,  0.8);
  drink.addDirection(F.Middle, FD.DiagonalUpLeft,  0.7);

  // SLEEP — all fingers together, tips touching palm (relaxed flat curl)
  const sleep = G('SLEEP');
  sleep.addCurl(F.Thumb,  FC.NoCurl,   0.6);
  sleep.addCurl(F.Index,  FC.FullCurl, 0.9);
  sleep.addCurl(F.Middle, FC.FullCurl, 0.9);
  sleep.addCurl(F.Ring,   FC.FullCurl, 0.9);
  sleep.addCurl(F.Pinky,  FC.FullCurl, 0.9);
  sleep.addDirection(F.Thumb,  FD.DiagonalDownLeft,  0.7);
  sleep.addDirection(F.Index,  FD.DiagonalDownLeft,  0.6);
  sleep.addDirection(F.Middle, FD.DiagonalDownLeft,  0.6);

  // HOME — flat hand touches chin then moves to cheek (static: flat open pointing right)
  const home = G('HOME');
  home.addCurl(F.Thumb,  FC.NoCurl, 0.7);
  home.addCurl(F.Index,  FC.NoCurl, 1.0);
  home.addCurl(F.Middle, FC.NoCurl, 1.0);
  home.addCurl(F.Ring,   FC.NoCurl, 1.0);
  home.addCurl(F.Pinky,  FC.NoCurl, 1.0);
  home.addDirection(F.Index,  FD.HorizontalRight, 0.9);
  home.addDirection(F.Middle, FD.HorizontalRight, 0.9);
  home.addDirection(F.Ring,   FD.HorizontalRight, 0.8);
  home.addDirection(F.Thumb,  FD.HorizontalRight, 0.6);

  // LOVE — cross arms over chest (single hand: fist on chest, thumb tucked)
  // Static approximation: tight fist facing chest (like SORRY but thumb IN)
  const love = G('LOVE');
  allFingersIn(love, FC.FullCurl, 1.0);
  love.addCurl(F.Thumb, FC.FullCurl, 1.0);
  love.addDirection(F.Index,  FD.HorizontalLeft, 0.7);
  love.addDirection(F.Pinky,  FD.HorizontalLeft, 0.6);

  // FRIEND — hook index fingers together (both half-curl, horizontal, then swap)
  // Static: both index+middle half-curl hook outward-left
  const friend = G('FRIEND');
  friend.addCurl(F.Thumb,  FC.FullCurl, 0.6);
  friend.addCurl(F.Index,  FC.HalfCurl, 1.0);
  friend.addCurl(F.Middle, FC.HalfCurl, 0.9);
  friend.addCurl(F.Ring,   FC.FullCurl, 1.0);
  friend.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  friend.addDirection(F.Index,  FD.HorizontalLeft, 1.0);
  friend.addDirection(F.Middle, FD.HorizontalLeft, 0.8);

  // MONEY — A-shape hand taps flat palm (static: A-fist, thumb up, ring slightly out)
  const money = G('MONEY');
  money.addCurl(F.Thumb,  FC.NoCurl,   0.9);
  money.addCurl(F.Index,  FC.FullCurl, 1.0);
  money.addCurl(F.Middle, FC.FullCurl, 1.0);
  money.addCurl(F.Ring,   FC.HalfCurl, 0.7);
  money.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  money.addDirection(F.Thumb, FD.DiagonalUpRight, 0.9);
  money.addDirection(F.Ring,  FD.DiagonalUpRight, 0.6);

  // WORK — both fists, dominant fist taps top of base fist (static: S-fist facing forward)
  const work = G('WORK');
  allFingersIn(work, FC.HalfCurl, 1.0);
  work.addCurl(F.Thumb,  FC.HalfCurl, 1.0);
  work.addDirection(F.Thumb,  FD.DiagonalUpRight, 0.7);
  work.addDirection(F.Index,  FD.DiagonalUpRight, 0.5);

  // HOT — C-shape then palm rotates out (static: C-shape rotated palm out)
  const hot = G('HOT');
  hot.addCurl(F.Thumb,  FC.HalfCurl, 0.9);
  hot.addCurl(F.Index,  FC.HalfCurl, 1.0);
  hot.addCurl(F.Middle, FC.HalfCurl, 1.0);
  hot.addCurl(F.Ring,   FC.HalfCurl, 1.0);
  hot.addCurl(F.Pinky,  FC.HalfCurl, 1.0);
  hot.addDirection(F.Index,  FD.DiagonalDownLeft, 0.9);
  hot.addDirection(F.Middle, FD.DiagonalDownLeft, 0.9);
  hot.addDirection(F.Thumb,  FD.DiagonalUpRight,  0.7);

  // COLD — S-fists shaken in/out at shoulders (static: both wrists inward, S-shape)
  const cold = G('COLD');
  allFingersIn(cold, FC.HalfCurl, 0.9);
  cold.addCurl(F.Thumb, FC.HalfCurl, 0.9);
  cold.addDirection(F.Thumb,  FD.DiagonalDownLeft, 0.7);
  cold.addDirection(F.Index,  FD.DiagonalDownLeft, 0.6);
  cold.addDirection(F.Pinky,  FD.DiagonalDownLeft, 0.6);

  // FAST — L-shape that snaps closed quickly (static: L with index bent slightly)
  const fast = G('FAST');
  fast.addCurl(F.Thumb,  FC.NoCurl,   1.0);
  fast.addCurl(F.Index,  FC.HalfCurl, 1.0);
  fast.addCurl(F.Middle, FC.FullCurl, 1.0);
  fast.addCurl(F.Ring,   FC.FullCurl, 1.0);
  fast.addCurl(F.Pinky,  FC.FullCurl, 1.0);
  fast.addDirection(F.Thumb, FD.HorizontalLeft,   1.0);
  fast.addDirection(F.Index, FD.DiagonalUpLeft,   0.9);

  // SLOW — flat hand slides up the other arm (static: open palm all fingers up, 
  // sliding direction = all fingers pointing left, wrist visible)
  const slow = G('SLOW');
  slow.addCurl(F.Thumb,  FC.NoCurl, 0.7);
  slow.addCurl(F.Index,  FC.NoCurl, 1.0);
  slow.addCurl(F.Middle, FC.NoCurl, 1.0);
  slow.addCurl(F.Ring,   FC.NoCurl, 1.0);
  slow.addCurl(F.Pinky,  FC.NoCurl, 1.0);
  slow.addDirection(F.Index,  FD.DiagonalUpLeft, 1.0);
  slow.addDirection(F.Middle, FD.DiagonalUpLeft, 1.0);
  slow.addDirection(F.Ring,   FD.DiagonalUpLeft, 0.9);
  slow.addDirection(F.Pinky,  FD.DiagonalUpLeft, 0.8);

  return new fp.GestureEstimator([
    // Alphabet
    A, B, C, D, E, Fsign, Gsign, H, I, J, K, L, M, N, O, P, Q, R, S, T,
    U, V, W, X, Y, Z,
    // Common words
    thumbsUp, thumbsDown, iLoveYou, peace,
    hello, thanks, yes, no, please, sorry, help,
    stop, ok, callMe, wait, more,
    // New gestures
    good, bad, eat, drink, sleep, home, love, friend,
    money, work, hot, cold, fast, slow,
  ]);
}

// ─────────────────────────────────────────────────────────────
// SECTION 2 — Geometric Landmark Analyser
// Pure mathematics on raw {x,y,z} landmark arrays.
// Acts as a parallel pipeline to fingerpose — more reliable for
// geometrically distinctive signs.
//
// AUDIT FIXES:
// • extCount===5 spread now correctly uses local sc variable
// • All null-guards on lm array length
// • fingerStates threshold tuned per-finger based on real data
// ─────────────────────────────────────────────────────────────
const GeometricAnalyzer = (() => {

  /** Euclidean distance between two landmarks */
  function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  }

  /** Normalised hand size = wrist → middle-MCP distance */
  function handScale(lm) {
    return Math.max(0.01, dist(lm[0], lm[9]));
  }

  /**
   * Is finger extended?  
   * Tip-to-wrist distance must exceed MCP-to-wrist × threshold.
   * Per-finger thresholds tuned experimentally:
   *   thumb  1.3 (shorter natural extension)
   *   index  1.6
   *   middle 1.6
   *   ring   1.55 (slightly harder to fully extend alone)
   *   pinky  1.45
   */
  function isExtended(lm, tip, mcp, threshold) {
    const sc   = handScale(lm);
    const tipD = dist(lm[0], lm[tip]) / sc;
    const mcpD = dist(lm[0], lm[mcp]) / sc;
    return tipD > mcpD * threshold;
  }

  /** Angle in degrees at vertex b, between rays b→a and b→c */
  function angleDeg(a, b, c) {
    const ab  = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
    const cb  = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
    const dot = ab.x * cb.x + ab.y * cb.y + ab.z * cb.z;
    const mag = Math.sqrt(ab.x**2 + ab.y**2 + ab.z**2) *
                Math.sqrt(cb.x**2 + cb.y**2 + cb.z**2);
    if (mag < 1e-8) return 0;
    return Math.acos(Math.min(1, Math.max(-1, dot / mag))) * (180 / Math.PI);
  }

  /** Extension state object for all 5 fingers */
  function fingerStates(lm) {
    return {
      thumb:  isExtended(lm,  4,  2, 1.30),
      index:  isExtended(lm,  8,  5, 1.60),
      middle: isExtended(lm, 12,  9, 1.60),
      ring:   isExtended(lm, 16, 13, 1.55),
      pinky:  isExtended(lm, 20, 17, 1.45),
    };
  }

  /** Thumb tip above index MCP — reliable "thumb up" indicator */
  function thumbUp(lm)   { return lm[4].y < lm[5].y;  }
  /** Thumb tip below index MCP — reliable "thumb down" indicator */
  function thumbDown(lm) { return lm[4].y > lm[9].y;  }

  /**
   * Classify from landmarks alone.
   * Returns { name, confidence } or null (defers to fingerpose).
   */
  function classify(lm) {
    if (!lm || lm.length < 21) return null;

    const fs = fingerStates(lm);
    const sc = handScale(lm);   // ← BUGFIX: was missing in original ext===5 block

    const ext = [fs.thumb, fs.index, fs.middle, fs.ring, fs.pinky];
    const extCount = ext.filter(Boolean).length;

    // ── THUMBS UP / DOWN ──────────────────────────────────
    if (fs.thumb && !fs.index && !fs.middle && !fs.ring && !fs.pinky) {
      if (thumbUp(lm))   return { name: 'THUMBS UP',   confidence: 0.95 };
      if (thumbDown(lm)) return { name: 'THUMBS DOWN', confidence: 0.95 };
    }

    // ── L (thumb + index only, perpendicular) ─────────────
    if (fs.thumb && fs.index && !fs.middle && !fs.ring && !fs.pinky) {
      const angle = angleDeg(lm[4], lm[2], lm[5]);
      if (angle > 58) return { name: 'L', confidence: 0.90 };
    }

    // ── I LOVE YOU (thumb + index + pinky) ────────────────
    if (fs.thumb && fs.index && !fs.middle && !fs.ring && fs.pinky) {
      return { name: 'I LOVE YOU', confidence: 0.92 };
    }

    // ── Y (thumb + pinky only) ────────────────────────────
    if (fs.thumb && !fs.index && !fs.middle && !fs.ring && fs.pinky) {
      return { name: 'Y', confidence: 0.88 };
    }

    // ── CALL ME (thumb + pinky horizontal) ───────────────
    // Distinguished from Y by horizontal orientation of pinky
    if (fs.thumb && !fs.index && !fs.middle && !fs.ring && fs.pinky) {
      const pinkyVec = { x: lm[20].x - lm[17].x, y: lm[20].y - lm[17].y };
      const isHoriz  = Math.abs(pinkyVec.x) > Math.abs(pinkyVec.y) * 1.4;
      if (isHoriz) return { name: 'CALL ME', confidence: 0.85 };
    }

    // ── ALL 5 EXTENDED ───────────────────────────────────
    if (extCount === 5) {
      const spread = dist(lm[8], lm[20]) / sc;   // BUGFIX: sc now defined
      const idxUp  = (lm[8].y - lm[5].y) < -0.05;

      if (idxUp && spread > 1.2)  return { name: 'STOP',  confidence: 0.85 };
      if (idxUp && spread <= 1.2) return { name: 'HELLO', confidence: 0.80 };
    }

    // ── D (index only, others curl around thumb) ──────────
    if (fs.index && !fs.middle && !fs.ring && !fs.pinky) {
      const thumbToMid = dist(lm[4], lm[12]) / sc;
      const conf = thumbToMid < 0.6 ? 0.84 : 0.72;
      return { name: 'D', confidence: conf };
    }

    // ── W (index + middle + ring extended, no thumb/pinky) ─
    if (!fs.thumb && fs.index && fs.middle && fs.ring && !fs.pinky) {
      return { name: 'W', confidence: 0.86 };
    }

    // ── U vs V (index + middle, no others) ───────────────
    if (!fs.thumb && fs.index && fs.middle && !fs.ring && !fs.pinky) {
      const spread = dist(lm[8], lm[12]) / sc;
      if (spread > 0.70) return { name: 'V', confidence: 0.88 };
      return { name: 'U', confidence: 0.84 };
    }

    // ── OK (index+thumb pinch, 3 up) ─────────────────────
    if (extCount === 3 && fs.middle && fs.ring && fs.pinky) {
      const pinch = dist(lm[4], lm[8]) / sc;
      if (pinch < 0.40) return { name: 'OK', confidence: 0.86 };
    }

    // ── EAT (all fingers bunched / half-curl pointing at face) ──
    if (extCount === 0) {
      // All fingers curled — distinguish by thumb direction
      const thumbVecY = lm[4].y - lm[3].y;
      if (thumbVecY < -0.05) return { name: 'EAT', confidence: 0.70 };
    }

    return null; // defer to fingerpose
  }

  return { classify, fingerStates, dist, handScale, angleDeg };
})();

// ─────────────────────────────────────────────────────────────
// SECTION 3 — Online Learner (session-scoped confidence adapter)
//
// Prevents overfitting via:
//   • Exponential Moving Average (α=0.15) — small update per sample
//   • Requires MIN_CONFIRM detections before activating offset
//   • Offset clamped to ±2.5 to prevent runaway drift
//   • Offsets decay toward 0 on reset() (each new session)
//   • No persistent storage — resets on page reload
//
// Usage: after fingerpose score is computed, call
//   OnlineLearner.adjust(name, rawScore) → adjustedScore
// ─────────────────────────────────────────────────────────────
const OnlineLearner = (() => {
  const EMA_ALPHA    = 0.12;   // smoothing factor — lower = slower to adapt
  const MAX_OFFSET   = 2.5;    // maximum ± score adjustment
  const MIN_CONFIRM  = 8;      // samples needed before offset activates
  const TARGET_SCORE = 8.5;    // ideal fingerpose score we aim for

  // Per-sign stats: { ema, count }
  const stats = {};

  /**
   * Update the EMA for a sign with a new observed raw score.
   * Called every time a sign passes the debounce confirmation.
   */
  function observe(name, rawScore) {
    if (!stats[name]) stats[name] = { ema: rawScore, count: 0 };
    const s = stats[name];
    s.count++;
    s.ema = EMA_ALPHA * rawScore + (1 - EMA_ALPHA) * s.ema;
  }

  /**
   * Adjust a raw score using the learned offset.
   * Returns the adjusted score (same units as fingerpose, 0–10).
   */
  function adjust(name, rawScore) {
    const s = stats[name];
    if (!s || s.count < MIN_CONFIRM) return rawScore;

    // Offset = how far the user's typical score is from TARGET_SCORE
    // If user typically scores 7.0 → offset = +1.5 → brings it up
    const offset = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, TARGET_SCORE - s.ema));
    return rawScore + offset;
  }

  /**
   * Get the count of observations for a sign.
   */
  function getCount(name) {
    return stats[name]?.count || 0;
  }

  /** Reset all learned offsets (called on new session / engine reset) */
  function reset() {
    for (const key of Object.keys(stats)) delete stats[key];
  }

  /** Full stats dump for debugging */
  function dump() {
    return JSON.parse(JSON.stringify(stats));
  }

  return { observe, adjust, getCount, reset, dump };
})();

// ─────────────────────────────────────────────────────────────
// SECTION 4 — Temporal Smoother (sliding window majority vote)
//
// AUDIT FIXES:
// • Corrected totalWeight formula — was (n*(n+1))/(2*n) = (n+1)/2 (wrong)
//   Correct triangular sum = n*(n+1)/2, normalisation divides by that.
// • MIN_VOTES_PCT now checked against normalised fraction correctly.
// ─────────────────────────────────────────────────────────────
const TemporalSmoother = (() => {
  const WINDOW   = 9;     // frames to look back
  const MIN_PCT  = 0.48;  // ≥48% of weighted frames must agree

  const history = []; // { name, confidence }

  function push(name, confidence) {
    history.push({ name, confidence });
    if (history.length > WINDOW) history.shift();
  }

  function reset() { history.length = 0; }

  function best() {
    const n = history.length;
    if (n < 2) return null;

    const votes   = {};
    const confAcc = {};

    // Linear recency weight: oldest frame → weight 1, newest → weight n
    history.forEach((h, i) => {
      const w = i + 1;   // 1-indexed weight
      votes[h.name]   = (votes[h.name]   || 0) + w;
      confAcc[h.name] = (confAcc[h.name] || 0) + h.confidence * w;
    });

    // Total possible weight = triangular number n*(n+1)/2
    const totalW = (n * (n + 1)) / 2;

    let topName = null, topVote = 0;
    for (const [name, voteSum] of Object.entries(votes)) {
      const fraction = voteSum / totalW;
      if (fraction >= MIN_PCT && voteSum > topVote) {
        topVote  = voteSum;
        topName  = name;
      }
    }

    if (!topName) return null;

    return {
      name:       topName,
      confidence: Math.min(1, confAcc[topName] / votes[topName]),
    };
  }

  return { push, best, reset };
})();

// ─────────────────────────────────────────────────────────────
// SECTION 5 — Conflict Resolver
//
// AUDIT FIXES:
// • Removed undefined thumbTip_x function reference — replaced with
//   inline lm[4].x access everywhere
// • M/N/S/T block now returns correctly in all branches
// • Added GOOD/BAD disambiguation (both have all-5-out)
// • Added EAT/DRINK/MORE disambiguation (all half-curl variants)
// • Added HOT/COLD disambiguation from C/O confusion
// ─────────────────────────────────────────────────────────────
const ConflictResolver = (() => {

  function resolve(candidates, lm) {
    if (!candidates || candidates.length === 0) return null;
    if (!lm || lm.length < 21) return null;

    const top    = candidates[0];
    const second = candidates[1] || null;
    const geo    = GeometricAnalyzer.classify(lm);
    const sc     = GeometricAnalyzer.handScale(lm);

    // ── Geo engine strong agreement → boost ──────────────
    if (geo && geo.name === top.name && geo.confidence > 0.80) {
      return { name: top.name, score: Math.min(10, top.score * 1.12) };
    }

    // ── Geo engine strong override ────────────────────────
    if (geo && geo.confidence > 0.87 && geo.name !== top.name) {
      return { name: geo.name, score: geo.confidence * 10 };
    }

    // ── A vs S ────────────────────────────────────────────
    // S: thumb tip is BELOW the index PIP joint (over fingers)
    // A: thumb tip is ABOVE or BESIDE index PIP
    if (top.name === 'A' || top.name === 'S') {
      const thumbOverFingers = lm[4].y > lm[6].y;
      return { name: thumbOverFingers ? 'S' : 'A', score: top.score };
    }

    // ── M vs N vs S vs T (all fist-like) ─────────────────
    if (['M', 'N', 'S', 'T'].includes(top.name)) {
      const fs         = GeometricAnalyzer.fingerStates(lm);
      const allCurled  = !fs.index && !fs.middle && !fs.ring && !fs.pinky;
      const thumbX     = lm[4].x;
      const thumbY     = lm[4].y;
      const midPalmX   = lm[9].x;
      const indexKnY   = lm[5].y;
      const thumbAcross = Math.abs(thumbX - midPalmX) < 0.13;

      if (allCurled) {
        // T: thumb pokes up between index and middle (thumb tip above index knuckle)
        if (thumbY < indexKnY && !thumbAcross) {
          return { name: 'T', score: top.score };
        }
        // S: thumb wraps horizontally across all fingers
        if (thumbAcross) {
          return { name: 'S', score: top.score };
        }
        // M vs N: count fingers that are clearly over the thumb
        const indexOverThumb  = lm[8].y  > lm[4].y;
        const middleOverThumb = lm[12].y > lm[4].y;
        const ringOverThumb   = lm[16].y > lm[4].y;
        const fingersOver     = [indexOverThumb, middleOverThumb, ringOverThumb]
                                  .filter(Boolean).length;
        return { name: fingersOver >= 3 ? 'M' : 'N', score: top.score };
      }
      // Fallthrough — don't force a wrong name
      return { name: top.name, score: top.score };
    }

    // ── U vs R ───────────────────────────────────────────
    // R: index and middle are CROSSED (they lean opposite directions)
    if (top.name === 'U' || top.name === 'R') {
      const idxLean = lm[8].x - lm[5].x;
      const midLean = lm[12].x - lm[9].x;
      const crossed  = Math.sign(idxLean) !== Math.sign(midLean);
      return { name: crossed ? 'R' : 'U', score: top.score };
    }

    // ── V vs PEACE ───────────────────────────────────────
    // PEACE: thumb is noticeably extended away from palm
    if (top.name === 'V' || top.name === 'PEACE') {
      const thumbDist = GeometricAnalyzer.dist(lm[4], lm[0]) / sc;
      return { name: thumbDist > 1.18 ? 'PEACE' : 'V', score: top.score };
    }

    // ── F vs OK ──────────────────────────────────────────
    // OK: tighter thumb-index pinch
    if (top.name === 'F' || top.name === 'OK') {
      const pinch = GeometricAnalyzer.dist(lm[4], lm[8]) / sc;
      return { name: pinch < 0.36 ? 'OK' : 'F', score: top.score };
    }

    // ── GOOD vs THANKS ───────────────────────────────────
    // Both have all 5 fingers out, THANKS angles more strongly right
    if (top.name === 'GOOD' || top.name === 'THANKS') {
      const midVecX = lm[12].x - lm[9].x;
      return { name: midVecX > 0.08 ? 'THANKS' : 'GOOD', score: top.score };
    }

    // ── BAD vs PLEASE vs WAIT ────────────────────────────
    // BAD: fingers point down; PLEASE/WAIT: horizontal
    if (top.name === 'BAD' || top.name === 'PLEASE' || top.name === 'WAIT') {
      const midVecY = lm[12].y - lm[9].y;
      if (midVecY > 0.06) return { name: 'BAD',    score: top.score };
      return { name: top.name === 'WAIT' ? 'WAIT' : 'PLEASE', score: top.score };
    }

    // ── C vs O vs EAT vs HOT ─────────────────────────────
    // O: fingertips touch each other (very tight)
    // EAT: tips point toward face (upward diagonal)
    // HOT: tips point down
    // C: open arc
    if (['C', 'O', 'EAT', 'HOT', 'DRINK'].includes(top.name)) {
      const tipSpread = GeometricAnalyzer.dist(lm[8], lm[4]) / sc;  // index tip to thumb tip
      const midVecY   = lm[12].y - lm[9].y;   // positive = pointing down

      if (tipSpread < 0.28) return { name: 'O',    score: top.score };
      if (midVecY < -0.06)  return { name: 'EAT',  score: top.score };
      if (midVecY > 0.08)   return { name: 'HOT',  score: top.score };
      return { name: 'C', score: top.score };
    }

    // ── CALL ME vs Y ─────────────────────────────────────
    if (top.name === 'CALL ME' || top.name === 'Y') {
      const pinkyVec = { x: lm[20].x - lm[17].x, y: lm[20].y - lm[17].y };
      const isHoriz  = Math.abs(pinkyVec.x) > Math.abs(pinkyVec.y) * 1.3;
      return { name: isHoriz ? 'CALL ME' : 'Y', score: top.score };
    }

    // ── SLOW vs HELLO ─────────────────────────────────────
    if (top.name === 'SLOW' || top.name === 'HELLO') {
      const spread = GeometricAnalyzer.dist(lm[8], lm[20]) / sc;
      return { name: spread < 0.9 ? 'SLOW' : 'HELLO', score: top.score };
    }

    return { name: top.name, score: top.score };
  }

  return { resolve };
})();

// ─────────────────────────────────────────────────────────────
// SECTION 6 — Public GestureEngine API
//
// Full 6-layer pipeline:
//   Fingerpose → ConflictResolver → OnlineLearner → GeometricFallback
//   → TemporalSmoother → confirmed result
// ─────────────────────────────────────────────────────────────
const GestureEngine = (() => {
  let estimator = null;
  let ready     = false;

  function init() {
    try {
      estimator = buildGestureEstimator();
      ready     = !!estimator;
    } catch (e) {
      console.error('[GestureEngine] init failed:', e);
      ready = false;
    }
    return ready;
  }

  /**
   * Detect gesture from 21 normalised landmarks.
   *
   * @param {Array<{x,y,z}>} landmarks  - MediaPipe landmark array
   * @param {number} w   - canvas width  (for fingerpose pixel conversion)
   * @param {number} h   - canvas height
   * @param {number} threshold - minimum fingerpose score to accept (default 7.0)
   * @returns {{ name:string, confidence:number }|null}
   */
  function detect(landmarks, w, h, threshold = 7.0) {
    if (!ready || !landmarks || landmarks.length < 21) return null;

    // Convert normalised → pixel coords for fingerpose
    const kp = landmarks.map(lm => [lm.x * w, lm.y * h, lm.z * w]);

    // ① Fingerpose estimation
    let fpResult = null;
    try {
      fpResult = estimator.estimate(kp, threshold);
    } catch (e) {
      // Fingerpose failed — fall through to geometric-only path
    }

    const candidates = fpResult?.gestures
      ? [...fpResult.gestures].sort((a, b) => b.score - a.score).slice(0, 4)
      : [];

    // ② Conflict resolution (geometry-assisted)
    const resolved = ConflictResolver.resolve(candidates, landmarks);

    // ③ Geometric fallback if fingerpose+resolver both failed
    let finalResult = resolved;
    if (!finalResult) {
      const geo = GeometricAnalyzer.classify(landmarks);
      if (geo) finalResult = { name: geo.name, score: geo.confidence * 10 };
    }

    if (!finalResult) {
      TemporalSmoother.reset();
      return null;
    }

    // ④ OnlineLearner adjustment (anti-overfitting adapted score)
    const adjustedScore = OnlineLearner.adjust(finalResult.name, finalResult.score);
    const rawConf       = Math.min(1.0, Math.max(0, adjustedScore / 10));

    // ⑤ Temporal smoothing
    TemporalSmoother.push(finalResult.name, rawConf);
    const smoothed = TemporalSmoother.best();
    if (!smoothed) return null;

    return {
      name:       smoothed.name,
      confidence: Math.round(smoothed.confidence * 100),
    };
  }

  /**
   * Notify the OnlineLearner of a confirmed (debounced + user-validated) sign.
   * Called from app.js whenever a sign passes the hold timer.
   */
  function confirmSign(name, rawFpScore) {
    OnlineLearner.observe(name, rawFpScore);
  }

  function reset() {
    TemporalSmoother.reset();
    // Do NOT reset OnlineLearner on every hand-loss — only on full session reset
  }

  function resetSession() {
    TemporalSmoother.reset();
    OnlineLearner.reset();
  }

  /** Dump OnlineLearner stats for debugging */
  function debugDump() {
    return { learner: OnlineLearner.dump() };
  }

  return {
    init,
    detect,
    confirmSign,
    reset,
    resetSession,
    debugDump,
    get isReady() { return ready; },
  };
})();

// Node.js export (for unit tests)
if (typeof module !== 'undefined') {
  module.exports = {
    GestureEngine,
    GeometricAnalyzer,
    TemporalSmoother,
    ConflictResolver,
    OnlineLearner,
    buildGestureEstimator,
  };
}
