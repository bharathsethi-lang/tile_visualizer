/* ============================================================
   server/local-tile-engine.js
   Non-AI Mode's server-side counterpart to public/js/local-tile.js +
   perspective.js. Pure Node/JS array math over raw RGBA pixel buffers
   (decoded/encoded by `sharp` in index.js) — no Gemini/OpenAI, no
   network call of any kind. Used by POST /api/apply-tile-local.

   The browser engine reuses the tile catalog's own canvas painters
   (textures.js) to build a repeating pattern; there's no canvas/GPU
   available in this Node process, so this endpoint instead takes an
   already-rendered flat tile pattern image (PNG data URL) per layer —
   the browser already has one on hand (it's the same swatch drawn for
   the sidebar grid), so nothing about the tile's *look* changes,
   only where the perspective warp + compositing math runs.
   ============================================================ */

function solveLinear8(A, b){
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for(let col = 0; col < n; col++){
    let piv = col;
    for(let r = col + 1; r < n; r++){
      if(Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if(Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const pv = M[col][col];
    for(let c = col; c <= n; c++) M[col][c] /= pv;
    for(let r = 0; r < n; r++){
      if(r === col) continue;
      const f = M[r][col];
      if(f === 0) continue;
      for(let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map(row => row[n]);
}

function computeHomography(src, dst){
  const A = [], b = [];
  for(let i = 0; i < 4; i++){
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  const h = solveLinear8(A, b);
  if(!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function applyHomography(H, x, y){
  const X = H[0] * x + H[1] * y + H[2];
  const Y = H[3] * x + H[4] * y + H[5];
  const W = H[6] * x + H[7] * y + H[8];
  if(Math.abs(W) < 1e-9) return [X, Y];
  return [X / W, Y / W];
}

function invert3x3(H){
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, Hh = -(a * f - c * d), I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if(Math.abs(det) < 1e-12) return null;
  return [A / det, D / det, G / det, B / det, E / det, Hh / det, C / det, F / det, I / det];
}

function clampN(n, a, b){ return Math.max(a, Math.min(b, n)); }

/* Signed distance (in pixels) from (px,py) to the nearest edge of a
   convex quad, positive when inside. No canvas available server-side,
   so this stands in for the browser's blur-based feather: alpha ramps
   from 0 to 1 across `featherPx` as the point crosses each edge. */
function quadInsideDistance(px, py, polygon){
  let minDist = Infinity;
  let inside = true;
  const n = polygon.length;
  for(let i = 0; i < n; i++){
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % n];
    const ex = x2 - x1, ey = y2 - y1;
    const len = Math.hypot(ex, ey) || 1;
    const cross = (ex * (py - y1) - ey * (px - x1)) / len; // signed distance to this edge line
    if(cross < 0) inside = false;
    minDist = Math.min(minDist, Math.abs(cross));
  }
  return inside ? minDist : -minDist;
}

function quadBounds(corners, maxW, maxH){
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxX = Math.min(maxW, Math.ceil(Math.max(...xs)));
  const maxY = Math.min(maxH, Math.ceil(Math.max(...ys)));
  return { minX, minY, maxX, maxY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

/* Mutates `roomData` (RGBA Uint8Array/Buffer, width*height*4) in place. */
function applyPerspectiveTile(roomData, w, h, patternData, pw, ph, opts){
  const { corners, maskPoints, repeatU = 6, repeatV = 6, rotationDeg = 0, opacity = 1, feather = 6 } = opts;
  if(!corners || corners.length !== 4) return;
  const polygon = (maskPoints && maskPoints.length >= 3) ? maskPoints : corners;

  const unit = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const H = computeHomography(unit, corners);
  if(!H) return;
  const Hinv = invert3x3(H);
  if(!Hinv) return;

  const bounds = quadBounds(polygon, w, h);
  if(bounds.width <= 0 || bounds.height <= 0) return;

  // average luminance of the tile pattern, for lighting-preserving blend
  let sum = 0, count = pw * ph;
  for(let i = 0; i < patternData.length; i += 4){
    sum += 0.299 * patternData[i] + 0.587 * patternData[i + 1] + 0.114 * patternData[i + 2];
  }
  const avgLum = Math.max(20, sum / count);

  const ru = Math.max(0.25, repeatU), rv = Math.max(0.25, repeatV);
  const rot = rotationDeg * Math.PI / 180;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);

  for(let py = bounds.minY; py < bounds.maxY; py++){
    for(let px = bounds.minX; px < bounds.maxX; px++){
      const inside = quadInsideDistance(px + 0.5, py + 0.5, polygon);
      if(inside <= -feather) continue;
      const maskAlpha = clampN((inside + feather) / (feather * 2 + 0.001), 0, 1);
      if(maskAlpha <= 0.004) continue;

      let [u, v] = applyHomography(Hinv, px + 0.5, py + 0.5);
      const cu = u - 0.5, cv = v - 0.5;
      u = 0.5 + (cu * cosR - cv * sinR);
      v = 0.5 + (cu * sinR + cv * cosR);

      const su = ((u * ru) % 1 + 1) % 1;
      const sv = ((v * rv) % 1 + 1) % 1;
      const sx = clampN((su * pw) | 0, 0, pw - 1);
      const sy = clampN((sv * ph) | 0, 0, ph - 1);
      const si = (sy * pw + sx) * 4;
      const tr = patternData[si], tg = patternData[si + 1], tb = patternData[si + 2];

      const oi = (py * w + px) * 4;
      const or_ = roomData[oi], og = roomData[oi + 1], ob = roomData[oi + 2];
      const origLum = 0.299 * or_ + 0.587 * og + 0.114 * ob;
      // Subtle brightness matching only — see local-tile.js for why
      // this is clamped tight instead of letting old shading dominate.
      const lightFactor = clampN(origLum / avgLum, 0.85, 1.15);
      const ar = clampN(tr * lightFactor, 0, 255);
      const ag = clampN(tg * lightFactor, 0, 255);
      const ab = clampN(tb * lightFactor, 0, 255);

      const a = maskAlpha * clampN(opacity, 0, 1);
      roomData[oi]     = or_ * (1 - a) + ar * a;
      roomData[oi + 1] = og * (1 - a) + ag * a;
      roomData[oi + 2] = ob * (1 - a) + ab * a;
    }
  }
}

module.exports = { applyPerspectiveTile };
