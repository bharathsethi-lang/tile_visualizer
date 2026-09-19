/* ============================================================
   perspective.js — plain projective-geometry helpers, no DOM/AI.
   Used by local-tile.js (Non-AI Mode) to map a flat tile pattern
   onto an arbitrary quadrilateral (floor/wall corners) with real
   perspective, not a stretch. Pure math only, so this same logic
   is mirrored (not shared by reference) in server/local-tile-engine.js
   for the /api/apply-tile-local endpoint.
   ============================================================ */

/* Solve an 8x8 linear system A*h = b via Gaussian elimination with
   partial pivoting. Returns length-8 array, or null if singular. */
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

/* computeHomography(src, dst) — src/dst are arrays of 4 [x,y] points.
   Returns a 3x3 matrix H (row-major, length 9, H[8]=1) such that
   applyHomography(H, src[i][0], src[i][1]) ≈ dst[i]. Used here to map
   a unit square (0,0)-(1,0)-(1,1)-(0,1), representing "tile pattern
   space", onto a room's floor/wall quadrilateral in image-pixel space. */
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

function invertHomography3x3(H){
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, Hh = -(a * f - c * d), I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if(Math.abs(det) < 1e-12) return null;
  return [A / det, D / det, G / det, B / det, E / det, Hh / det, C / det, F / det, I / det];
}

/* Point-in-convex-quad test (corners in order, either winding). Used
   as a cheap pre-filter before the more expensive per-pixel inverse
   homography + feather lookup. */
function pointInQuad(px, py, corners){
  let sign = 0;
  for(let i = 0; i < 4; i++){
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % 4];
    const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
    if(cross !== 0){
      const s = cross > 0 ? 1 : -1;
      if(sign === 0) sign = s;
      else if(s !== sign) return false;
    }
  }
  return true;
}

function quadBounds(corners, maxW, maxH){
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxX = Math.min(maxW, Math.ceil(Math.max(...xs)));
  const maxY = Math.min(maxH, Math.ceil(Math.max(...ys)));
  return { minX, minY, maxX, maxY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

/* Not a module system here on purpose (loaded via plain <script> tags
   like the rest of the app) — these are just plain globals. */
