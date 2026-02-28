/* ============================================================
   SignBridge — Canvas Renderer v2
   
   Features:
   - Gradient skeleton with per-bone colouring
   - Animated "pulse" on fingertips when sign confirmed
   - Heat-map style depth shading on landmarks (z-axis)
   - Bounding box with animated corner brackets
   - Palm velocity vector (motion trail)
   - Multi-hand support
   ============================================================ */

'use strict';

const Renderer = (() => {

  // ── Colour palette ──
  const C = {
    green:     '#00ff88',
    cyan:      '#00e5ff',
    red:       '#ff3366',
    orange:    '#ff8800',
    yellow:    '#ffff00',
    white:     'rgba(255,255,255,0.9)',
    greenDim:  'rgba(0,255,136,0.5)',
    cyanDim:   'rgba(0,229,255,0.5)',
  };

  // MediaPipe hand skeleton connection table
  const CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],           // Thumb
    [0,5],[5,6],[6,7],[7,8],           // Index
    [0,9],[9,10],[10,11],[11,12],      // Middle
    [0,13],[13,14],[14,15],[15,16],    // Ring
    [0,17],[17,18],[18,19],[19,20],    // Pinky
    [5,9],[9,13],[13,17],              // Palm arc
    [0,5],[0,17],                      // Wrist fans
  ];

  // Landmark classification
  const FINGERTIPS = new Set([4, 8, 12, 16, 20]);
  const KNUCKLES   = new Set([5, 9, 13, 17]);
  const MID_JOINTS = new Set([6, 7, 10, 11, 14, 15, 18, 19]);
  const THUMB_JOINTS = new Set([1, 2, 3, 4]);

  // Per-finger gradient colours for skeleton bones
  const FINGER_COLORS = [
    ['#ff6b35','#ffaa00'],  // Thumb  — orange
    ['#00ff88','#00e5ff'],  // Index  — green→cyan
    ['#00e5ff','#7b2fff'],  // Middle — cyan→purple
    ['#7b2fff','#ff3366'],  // Ring   — purple→pink
    ['#ff3366','#ff6b35'],  // Pinky  — pink→orange
  ];

  // Bone group → finger index mapping
  const BONE_FINGER = {
    '0-1':0,'1-2':0,'2-3':0,'3-4':0,
    '0-5':1,'5-6':1,'6-7':1,'7-8':1,
    '0-9':2,'9-10':2,'10-11':2,'11-12':2,
    '0-13':3,'13-14':3,'14-15':3,'15-16':3,
    '0-17':4,'17-18':4,'18-19':4,'19-20':4,
  };

  // Motion trail storage per hand
  const palmTrail = {};
  const MAX_TRAIL = 6;

  // Pulse animation state
  let pulseFrame = 0;
  let lastConfirmedSign = '';
  let pulseActive = false;
  let pulseTimer  = null;

  /** Trigger pulse animation on confirmed sign */
  function triggerPulse(sign) {
    if (sign && sign !== '—') {
      lastConfirmedSign = sign;
      pulseActive = true;
      clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => { pulseActive = false; }, 1200);
    }
  }

  // ──────────────────────────────────────────────
  // Drawing primitives
  // ──────────────────────────────────────────────

  /** Draw hand skeleton with per-finger gradient colouring */
  function drawSkeleton(ctx, lm, w, h) {
    ctx.save();
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    for (const [a, b] of CONNECTIONS) {
      const lA = lm[a], lB = lm[b];
      if (!lA || !lB) continue;

      const key = `${a}-${b}`;
      const fi  = BONE_FINGER[key];
      const [colA, colB] = fi !== undefined ? FINGER_COLORS[fi] : [C.cyan, C.green];

      const x1 = lA.x * w, y1 = lA.y * h;
      const x2 = lB.x * w, y2 = lB.y * h;

      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      grad.addColorStop(0, colA + 'cc');
      grad.addColorStop(1, colB + 'cc');

      // Line width varies by joint depth (z): closer = thicker
      const depth = Math.max(0, Math.min(1, 1 - (((lA.z + lB.z) / 2) + 0.2)));
      ctx.lineWidth   = 1.5 + depth * 1.5;
      ctx.strokeStyle = grad;
      ctx.shadowColor = colA;
      ctx.shadowBlur  = 3 + depth * 4;

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.restore();
  }

  /** Draw 21 landmark dots with depth-aware sizing */
  function drawLandmarks(ctx, lm, w, h) {
    ctx.save();

    lm.forEach((pt, idx) => {
      const x = pt.x * w;
      const y = pt.y * h;
      // z in MediaPipe is negative-closer; normalise to 0–1
      const depthFactor = Math.max(0, Math.min(1, 1 - (pt.z + 0.2)));

      let r, fill, stroke, glow, blur;

      if (FINGERTIPS.has(idx)) {
        r      = 4 + depthFactor * 3;
        fill   = C.green;
        stroke = C.white;
        glow   = C.green;
        blur   = 10 + (pulseActive ? 14 * Math.sin(pulseFrame * 0.3) : 0);
      } else if (KNUCKLES.has(idx)) {
        r      = 3 + depthFactor * 2;
        fill   = 'rgba(0,255,136,0.85)';
        stroke = C.cyanDim;
        glow   = C.cyan;
        blur   = 5;
      } else if (idx === 0) {
        r      = 5;
        fill   = C.cyan;
        stroke = C.green;
        glow   = C.cyan;
        blur   = 8;
      } else if (THUMB_JOINTS.has(idx)) {
        r      = 2.5;
        fill   = '#ff9944aa';
        stroke = '#ff6b3566';
        glow   = C.orange;
        blur   = 4;
      } else {
        r      = 2 + depthFactor * 1.5;
        fill   = C.cyanDim;
        stroke = C.greenDim;
        glow   = C.green;
        blur   = 2;
      }

      ctx.shadowColor = glow;
      ctx.shadowBlur  = blur;
      ctx.fillStyle   = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth   = 1.2;

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Pulse ring on fingertips when sign confirmed
      if (pulseActive && FINGERTIPS.has(idx)) {
        const pr = r + 5 + 8 * Math.abs(Math.sin(pulseFrame * 0.25 + idx));
        ctx.beginPath();
        ctx.arc(x, y, pr, 0, Math.PI * 2);
        ctx.strokeStyle = C.green + '55';
        ctx.lineWidth   = 1;
        ctx.shadowBlur  = 0;
        ctx.stroke();
      }
    });

    ctx.restore();
  }

  /** Draw bounding box with animated corner brackets */
  function drawBoundingBox(ctx, lm, w, h, sign, confirmed) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of lm) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }

    const pad = 0.04;
    const bx = Math.max(0, (minX - pad)) * w;
    const by = Math.max(0, (minY - pad)) * h;
    const bw = Math.min(w, (maxX - minX + pad * 2) * w);
    const bh = Math.min(h, (maxY - minY + pad * 2) * h);

    const boxCol  = confirmed ? C.cyan : C.green;
    const dashCol = confirmed ? 'rgba(0,229,255,0.4)' : 'rgba(0,255,136,0.28)';

    ctx.save();

    // Dashed outline
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = dashCol;
    ctx.lineWidth   = 1.5;
    ctx.shadowColor = boxCol;
    ctx.shadowBlur  = 6;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.setLineDash([]);

    // Corner L-brackets
    const cLen = Math.min(20, bw * 0.2, bh * 0.2);
    ctx.lineWidth   = confirmed ? 3.5 : 2.5;
    ctx.strokeStyle = boxCol;
    ctx.shadowColor = boxCol;
    ctx.shadowBlur  = confirmed ? 14 : 8;
    ctx.lineCap     = 'square';

    const corners = [
      [bx, by, 1, 1],
      [bx + bw, by, -1, 1],
      [bx, by + bh, 1, -1],
      [bx + bw, by + bh, -1, -1],
    ];

    for (const [cx, cy, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + dy * cLen);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + dx * cLen, cy);
      ctx.stroke();
    }

    // Sign label above the box
    if (sign && sign !== '—') {
      ctx.font        = `bold 12px "Orbitron", monospace`;
      ctx.fillStyle   = boxCol;
      ctx.shadowColor = boxCol;
      ctx.shadowBlur  = 10;
      ctx.fillText(sign, bx + 4, Math.max(14, by - 4));
    }

    ctx.restore();
  }

  /** Draw palm motion trail */
  function drawTrail(ctx, handId, lm, w, h) {
    if (!palmTrail[handId]) palmTrail[handId] = [];
    const trail = palmTrail[handId];

    const palmPt = { x: lm[9].x * w, y: lm[9].y * h };
    trail.push({ ...palmPt });
    if (trail.length > MAX_TRAIL) trail.shift();

    if (trail.length < 2) return;

    ctx.save();
    for (let i = 1; i < trail.length; i++) {
      const alpha = i / trail.length;
      ctx.strokeStyle = `rgba(0,229,255,${alpha * 0.4})`;
      ctx.lineWidth   = alpha * 2;
      ctx.shadowColor = C.cyan;
      ctx.shadowBlur  = alpha * 5;
      ctx.beginPath();
      ctx.moveTo(trail[i-1].x, trail[i-1].y);
      ctx.lineTo(trail[i].x,   trail[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Draw crosshair on palm centre (landmark 9) */
  function drawCrosshair(ctx, lm, w, h) {
    const pt = lm[9];
    if (!pt) return;
    const cx = pt.x * w, cy = pt.y * h;
    const sz = 10;

    ctx.save();
    ctx.strokeStyle = 'rgba(0,229,255,0.45)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx - sz, cy); ctx.lineTo(cx + sz, cy);
    ctx.moveTo(cx, cy - sz); ctx.lineTo(cx, cy + sz);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** Draw hand label (LEFT / RIGHT) if multiHandedness provided */
  function drawHandLabel(ctx, lm, w, h, label) {
    if (!label) return;
    const wrist = lm[0];
    const x = wrist.x * w;
    const y = Math.max(14, wrist.y * h - 12);

    ctx.save();
    ctx.font = '10px "Orbitron", monospace';
    ctx.fillStyle   = 'rgba(0,229,255,0.7)';
    ctx.shadowColor = C.cyan;
    ctx.shadowBlur  = 6;
    ctx.fillText(label, x, y);
    ctx.restore();
  }

  /** Clear the entire canvas */
  function clear(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
  }

  /**
   * Full render pass for one hand.
   */
  function render(ctx, lm, w, h, opts = {}) {
    if (!lm || lm.length < 21) return;

    pulseFrame++;

    if (opts.showTrail !== false) {
      drawTrail(ctx, opts.handId || 0, lm, w, h);
    }

    if (opts.showSkeleton !== false) {
      drawSkeleton(ctx, lm, w, h);
      drawLandmarks(ctx, lm, w, h);
      drawCrosshair(ctx, lm, w, h);
    }

    drawBoundingBox(ctx, lm, w, h, opts.sign || '', opts.confirmed || false);

    if (opts.handLabel) {
      drawHandLabel(ctx, lm, w, h, opts.handLabel);
    }
  }

  return {
    render,
    clear,
    triggerPulse,
    CONNECTIONS,
  };
})();
