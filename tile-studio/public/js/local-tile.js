/* ============================================================
   local-tile.js — Non-AI Mode compositing engine.
   Deterministic, local, no network calls. Given a room image, a
   floor/wall quadrilateral, and a tile from the shared tiles.js
   catalog, this warps a repeating tile pattern into the quad with
   real perspective (a homography from perspective.js), feathers the
   mask edge, and blends it back over the original pixels so lighting/
   shadows/furniture outside the mask are pixel-identical to the
   source photo. Nothing here touches Gemini/OpenAI — it only uses
   Canvas 2D + plain array math.
   ============================================================ */

const LocalTileEngine = (function(){

  const patternCache = new Map(); // key: `${tileId}:${size}` -> {canvas, avgLum}
  const MIN_JOINT_PX = 1.5;       // thinnest a grout joint is ever drawn, in screen pixels
  const THIN_JOINT_GAMMA = 0.3;   // <1 keeps thin joints readable; 1 = strictly proportional to real width

  /* Build (or fetch from cache) a pattern swatch for a tile — this
     represents ONE physical tile's surface (grout is added separately,
     as a border, once real-world repeat counts are known — see
     applyLayer). Reuses the tile's own procedural `paint(ctx,size,1)`
     painter when present, or the tile's real photographed diffuse
     texture otherwise — both are the project's *existing* tile assets,
     nothing new is drawn. Density is fixed at 1 (a neutral "one tile"
     rendering); how many times that tile actually repeats across a
     surface is now driven entirely by real cm measurements in
     applyLayer, not by this swatch's internal detail level. */
  function getPattern(tileDef, size, height){
    height = height || size;
    const key = `${tileDef.id}:${size}x${height}`;
    if(patternCache.has(key)) return patternCache.get(key);

    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = height;
    const ctx = canvas.getContext('2d');

    const entry = { canvas, avgLum: 128, ready: false, listeners: [] };
    patternCache.set(key, entry);

    const finish = () => {
      const data = ctx.getImageData(0, 0, size, height).data;
      let sum = 0;
      for(let i = 0; i < data.length; i += 4){
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      entry.avgLum = sum / (data.length / 4);
      entry.ready = true;
      entry.listeners.forEach(fn => fn());
      entry.listeners.length = 0;
    };

    if(tileDef.photo){
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, size, height); finish(); };
      img.onerror = () => { ctx.fillStyle = '#8a8378'; ctx.fillRect(0, 0, size, size); finish(); };
      img.src = tileDef.photo.base + tileDef.photo.diffuse;
    } else {
      // This swatch is ONE tile face; the joints are drawn by applyLayer.
      // Ask the painter to leave out any seams it would normally bake in
      // (see PAINTER_OPTIONS in textures.js) or they show up as extra
      // horizontal/vertical lines through the middle of every tile.
      const hadOpts = (typeof PAINTER_OPTIONS !== 'undefined');
      const prevSeams = hadOpts ? PAINTER_OPTIONS.seams : true;
      if(hadOpts) PAINTER_OPTIONS.seams = false;
      // Procedural catalog painters historically accept a single square `size`.
      // Non-AI Mode, however, renders ONE physical tile face whose canvas is
      // rectangular when Length != Width. Paint into a square source first,
      // then map that complete source into the actual tile-face aspect ratio.
      // This keeps the renderer's physical lattice (repeatU/repeatV) and the
      // catalog material in agreement instead of silently making every
      // rectangular tile square.
      const paintSize = Math.max(size, height);
      const source = document.createElement('canvas');
      source.width = paintSize; source.height = paintSize;
      const sourceCtx = source.getContext('2d');
      try {
        tileDef.paint(sourceCtx, paintSize, 1);
        ctx.drawImage(source, 0, 0, paintSize, paintSize, 0, 0, size, height);
      } finally {
        if(hadOpts) PAINTER_OPTIONS.seams = prevSeams;
      }
      finish();
    }
    return entry;
  }

  function whenReady(entry){
    if(entry.ready) return Promise.resolve(entry);
    return new Promise(resolve => entry.listeners.push(() => resolve(entry)));
  }

  /* Draws a grout border around a single tile unit — since real-world
     repeat counts (repeatU/repeatV in applyLayer) now do the actual
     tiling, this only needs to mark ONE tile's edge, not an internal
     sub-grid. Kept separate from textures.js's painters so Non-AI
     Mode's "Grout" slider has something distinct to control without
     touching the shared AI+3D texture code. */
  function withGroutBorder(sourceCanvas, amount){
    if(amount <= 0.001) return sourceCanvas;
    const size = sourceCanvas.width;
    const out = document.createElement('canvas');
    out.width = size; out.height = size;
    const ctx = out.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0);
    const a = clampN(amount, 0, 1);
    ctx.strokeStyle = `rgba(20,18,16,${a * 0.9})`;
    ctx.lineWidth = Math.max(1, size * 0.012 * clampN(amount, 0.2, 1.5));
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, size - ctx.lineWidth, size - ctx.lineWidth);
    return out;
  }

  function clampN(n, a, b){ return Math.max(a, Math.min(b, n)); }
  function sampleGridEdge(points, t){
    if(points.length === 1) return [points[0].x,points[0].y];
    let total=0; const lens=[];
    for(let i=1;i<points.length;i++){ const d=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y); lens.push(d); total+=d; }
    if(total<1e-6) return [points[0].x,points[0].y];
    let d=clampN(t,0,1)*total;
    for(let i=0;i<lens.length;i++){
      if(d<=lens[i]){ const q=lens[i]<1e-6?0:d/lens[i]; return [points[i].x+(points[i+1].x-points[i].x)*q,points[i].y+(points[i+1].y-points[i].y)*q]; }
      d-=lens[i];
    }
    const p=points[points.length-1]; return [p.x,p.y];
  }
  function buildCurvedMapper(points){
    if(!points || points.length<=4) return null;
    const anchors=points.filter(p=>p.anchor).sort((a,b)=>(a.index??0)-(b.index??0));
    if(anchors.length!==4) return null;
    const edges=[0,1,2,3].map(e=>{
      const start=e,end=(e+1)%4;
      const mids=points.filter(p=>!p.anchor && p.edge===e).sort((a,b)=>Math.hypot(a.x-anchors[start].x,a.y-anchors[start].y)-Math.hypot(b.x-anchors[start].x,b.y-anchors[start].y));
      return [{x:anchors[start].x,y:anchors[start].y},...mids,{x:anchors[end].x,y:anchors[end].y}];
    });
    return (u,v)=>{
      u=clampN(u,0,1); v=clampN(v,0,1);
      const T=sampleGridEdge(edges[0],u), R=sampleGridEdge(edges[1],v), B=sampleGridEdge(edges[2],1-u), L=sampleGridEdge(edges[3],1-v);
      const P00=[anchors[0].x,anchors[0].y],P10=[anchors[1].x,anchors[1].y],P11=[anchors[2].x,anchors[2].y],P01=[anchors[3].x,anchors[3].y];
      return [
        (1-v)*T[0]+v*B[0]+(1-u)*L[0]+u*R[0]-((1-u)*(1-v)*P00[0]+u*(1-v)*P10[0]+u*v*P11[0]+(1-u)*v*P01[0]),
        (1-v)*T[1]+v*B[1]+(1-u)*L[1]+u*R[1]-((1-u)*(1-v)*P00[1]+u*(1-v)*P10[1]+u*v*P11[1]+(1-u)*v*P01[1])
      ];
    };
  }
  function invertCurvedMapper(mapper, x, y, seedU, seedV){
    let u=clampN(seedU,0,1), v=clampN(seedV,0,1);
    const eps=0.001;
    for(let it=0;it<3;it++){
      const p=mapper(u,v), pu=mapper(clampN(u+eps,0,1),v), pv=mapper(u,clampN(v+eps,0,1));
      const du=pu[0]-p[0], dv=pu[1]-p[1], eu=pv[0]-p[0], ev=pv[1]-p[1];
      const stepU=Math.max(eps, Math.min(1, u+eps)-u), stepV=Math.max(eps, Math.min(1, v+eps)-v);
      const a=du/stepU,b=eu/stepV,c=dv/stepU,d=ev/stepV, det=a*d-b*c;
      if(Math.abs(det)<1e-7) break;
      const ex=x-p[0], ey=y-p[1];
      u=clampN(u+(d*ex-b*ey)/det,0,1); v=clampN(v+(-c*ex+a*ey)/det,0,1);
    }
    return [u,v];
  }
  function smoothstep(e0, e1, x){
    const t = clampN((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* How much of one pixel a grout joint covers, along a single axis.
     d  = distance from the pixel centre to the joint's lattice line
     hw = the joint's real half-width
     fw = half the pixel's footprint on the surface
     (all in tile units along that axis).

     Testing "is the pixel centre inside the joint?" makes a joint that is
     narrower than a pixel appear and vanish at random, row to row. On a
     floor seen in perspective the rows are squashed vertically, so it is
     the horizontal joints that fall below a pixel first (a 10 mm joint can
     be ~0.5 px tall while the vertical ones are ~2 px wide) - which shows
     up as broken, uneven horizontal grout. Instead, average the joint over
     the pixel's footprint (a box filter) and never let a joint be thinner
     than about one pixel, so every row of grout stays continuous. */
  function jointCoverage(d, hw, fw){
    if(fw < 1e-6) return d < hw ? 1 : 0;
    const avg = Math.min(1, 2 * hw);
    // The pixel spans a whole tile or more: only the average joint share means anything.
    if(fw >= 0.5) return avg;
    // ~1.5 px minimum (fw is HALF a pixel). Wider than 1 px so the line's
    // darkness barely changes whether it lands on one pixel or straddles two.
    const h = Math.max(hw, MIN_JOINT_PX * fw);
    const lo = Math.max(d - fw, -h), hi = Math.min(d + fw, h);
    let filtered = hi > lo ? (hi - lo) / (2 * fw) : 0;
    // The line was widened to ~1.5 px so it stays continuous - but that must
    // not also make it full-strength. Scale it back by how much wider than
    // the real joint it had to be, so a hair-thin joint (small Grout value)
    // is a faint line and darkness grows smoothly with the slider instead of
    // jumping straight to a solid black line.
    filtered *= Math.pow(Math.min(1, hw / h), THIN_JOINT_GAMMA);
    // Fade to the plain average as pixels start spanning several tiles.
    const t = fw <= 0.25 ? 0 : (fw - 0.25) / 0.25;
    return filtered + (avg - filtered) * t;
  }

  /* Feathered alpha mask for one quad, sized to the quad's bounding
     box only (cheaper than a full-image mask). White polygon on
     black, blurred by `featherPx` — this is what makes the tile edge
     blend into the room instead of ending in a hard cutout line. */
  function buildFeatheredMask(corners, bounds, featherPx){
    const c = document.createElement('canvas');
    c.width = Math.max(1, bounds.width);
    c.height = Math.max(1, bounds.height);
    const ctx = c.getContext('2d');
    // Transparent everywhere except the polygon itself — the mask is
    // read back via the ALPHA channel (see applyLayer), so "outside"
    // must be alpha 0, not just visually black. (A black/white *opaque*
    // fill here would leave alpha=255 everywhere, painting the tile
    // across the whole bounding box regardless of the polygon's actual,
    // possibly-concave, shape.)
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    corners.forEach(([x, y], i) => {
      const lx = x - bounds.minX, ly = y - bounds.minY;
      i === 0 ? ctx.moveTo(lx, ly) : ctx.lineTo(lx, ly);
    });
    ctx.closePath();
    ctx.fill();
    if(featherPx > 0.1){
      try{
        const blurred = document.createElement('canvas');
        blurred.width = c.width; blurred.height = c.height;
        const bctx = blurred.getContext('2d');
        bctx.filter = `blur(${featherPx}px)`;
        bctx.drawImage(c, 0, 0);
        return bctx.getImageData(0, 0, c.width, c.height);
      } catch(e){ /* filter unsupported — fall through to hard edge */ }
    }
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  /* Core per-surface compositor. Mutates `outCtx` in place, reading
     original pixels from it for lighting-preservation, so callers
     should composite floor/wall onto a fresh copy of the untouched
     base image each time rather than stacking onto previous results
     — that's what keeps Non-AI Mode fully deterministic/reversible,
     unlike AI Mode's necessarily-stacked edit calls. */
  async function applyLayer(outCtx, canvasW, canvasH, layer){
    const {
      corners, maskPoints, perspectivePoints, tileDef,
      repeatU = 6, repeatV = 6,
      rotationDeg = 0, opacity = 1,
      grout = 0.5, feather = 6,
      tileLengthCm = 60, tileWidthCm = 60, materialScale = 1,
      excludePolygons = []
    } = layer;
    if(!tileDef || !corners || corners.length !== 4) return;

    // IMPORTANT: the mask is only the paint/visibility region. It is NOT
    // stretched into a rectangle and it does not define the tile geometry.
    const polygon = (maskPoints && maskPoints.length >= 3) ? maskPoints : corners;

    // One canvas = ONE physical tile face. The grid below is made from
    // individual cells; we never UV-stretch one room-sized texture.
    const tilePxBase = 192;
    const aspect = Math.max(0.05, tileWidthCm / Math.max(1, tileLengthCm));
    const pw = aspect >= 1 ? Math.round(tilePxBase * aspect) : tilePxBase;
    const ph = aspect >= 1 ? tilePxBase : Math.round(tilePxBase / aspect);
    const entry = getPattern(tileDef, pw, ph);
    await whenReady(entry);

    const unit = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const H = computeHomography(unit, corners);
    if(!H) return;
    const Hinv = invertHomography3x3(H);
    if(!Hinv) return;
    const curvedMapper = buildCurvedMapper(perspectivePoints);

    const bounds = quadBounds(polygon, canvasW, canvasH);
    if(bounds.width <= 0 || bounds.height <= 0) return;

    const maskData = buildFeatheredMask(polygon, bounds, feather);
    const outData = outCtx.getImageData(bounds.minX, bounds.minY, bounds.width, bounds.height);
    const patternCtx = entry.canvas.getContext('2d');
    const patternData = patternCtx.getImageData(0, 0, pw, ph).data;

    // repeatU/repeatV are the exact physical number of tile lengths/widths
    // across the supplied surface, measured ALONG THE TILE LATTICE AXES (the
    // caller already swaps them for quarter-turn rotations - see repeatsFor
    // in photo-mode-local.js). Non-integer counts intentionally create
    // partial tiles at the boundary (e.g. 2.4 tiles = 2 full + 0.4 tile).
    const ru = Math.max(0.001, repeatU);
    const rv = Math.max(0.001, repeatV);
    const rot = rotationDeg * Math.PI / 180;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);

    // Grout is a real physical joint between adjacent tile faces. Keep it
    // separate from the source texture and never paint grout on the outside
    // boundary of the surface. The slider maps to 0..20 mm so the groove can
    // remain visible on large-format tiles while still being expressed in
    // real-world units.
    const groutMm = clampN(grout, 0, 1) * 20;
    const textureScale = clampN(Number(materialScale) || 1, 0.5, 2);
    const groutU = Math.min(0.12, groutMm / Math.max(1, tileWidthCm * 10));
    const groutV = Math.min(0.12, groutMm / Math.max(1, tileLengthCm * 10));
    const hwU = groutU / 2, hwV = groutV / 2;

    // Edge chamfer on each tile face, in real millimetres (not as a fraction
    // of the tile) so long/narrow tiles get the same chamfer on every edge.
    const bevelMm = 4;
    const bevelU = Math.min(0.03, bevelMm / Math.max(1, tileWidthCm * 10));
    const bevelV = Math.min(0.03, bevelMm / Math.max(1, tileLengthCm * 10));

    const avgLum = Math.max(20, entry.avgLum);

    // Grout look. Strength ramps up smoothly from 0 (no joint, just the tile
    // chamfer) instead of switching to full black at the first notch, and the
    // deepest joint colour is relative to the tile rather than near-black.
    const groutAmount = clampN(grout, 0, 1);
    const groutStrength = Math.pow(groutAmount, 0.5);
    const deepGrout = clampN(avgLum * 0.32, 14, 64);

    // Surface (u,v) -> tile-lattice (u',v') as an affine map:
    //   u' = m00*u + m01*v + o0,   v' = m10*u + m11*v + o1
    // Exact quarter-turns remap the coordinates directly so the lattice
    // stays aligned to the surface edges. Rotating around (0.5,0.5) would
    // put a false joint through the middle of a one-tile dimension (for
    // example 60 x 600 on a 600 x 600 floor). Other angles keep the
    // centred-rotation behaviour.
    const quarter = ((rotationDeg % 360) + 360) % 360;
    const eps = 0.0001;
    let m00 = 1, m01 = 0, m10 = 0, m11 = 1, o0 = 0, o1 = 0;
    if(Math.abs(quarter - 0) < eps){
      // identity
    } else if(Math.abs(quarter - 90) < eps){
      m00 = 0; m01 = 1;  o0 = 0;   // u' = v
      m10 = -1; m11 = 0; o1 = 1;   // v' = 1 - u
    } else if(Math.abs(quarter - 180) < eps){
      m00 = -1; m01 = 0; o0 = 1;
      m10 = 0; m11 = -1; o1 = 1;
    } else if(Math.abs(quarter - 270) < eps){
      m00 = 0; m01 = -1; o0 = 1;   // u' = 1 - v
      m10 = 1; m11 = 0;  o1 = 0;   // v' = u
    } else {
      m00 = cosR;  m01 = -sinR; o0 = 0.5 - 0.5 * cosR + 0.5 * sinR;
      m10 = sinR;  m11 = cosR;  o1 = 0.5 - 0.5 * sinR - 0.5 * cosR;
    }

    // A lattice line only counts as a joint if it is INTERNAL: strictly
    // inside the surface. The outside edge is a crop, not a joint (so a
    // 60 x 600 plank rotated 90 degrees across a 600 x 600 floor has one
    // row in depth and no horizontal joint at all).
    const INTERNAL_EPS = 1e-4;

    const [ia, ib, ic, id, ie, iff, ig, ih, ii] = Hinv;

    // ...UNLESS the paint region runs past the 4 anchor corners (typical when
    // the floor continues beyond the bottom/sides of the photo but the anchors
    // can't be dragged off-canvas, so extra mask points are used to cover it).
    // There the floor keeps going, so the tile lattice must keep going too:
    // otherwise the last joint stops at the anchor edge and the strip past it
    // becomes one oversized, joint-less tile row. Work out how far the paint
    // polygon reaches in lattice units on each side and keep joints alive there.
    let extLoU = false, extHiU = false, extLoV = false, extHiV = false;
    {
      let cx = 0, cy = 0;
      corners.forEach(([x, y]) => { cx += x / 4; cy += y / 4; });
      const wc = ig * cx + ih * cy + ii;
      let minGU = Infinity, maxGU = -Infinity, minGV = Infinity, maxGV = -Infinity, ok = true;
      for(const [x, y] of polygon){
        const w = ig * x + ih * y + ii;
        if(w * wc <= 1e-9){ ok = false; break; }   // at/behind the horizon - can't extend sanely
        const u = (ia * x + ib * y + ic) / w, v = (id * x + ie * y + iff) / w;
        const gu = (m00 * u + m01 * v + o0) * ru, gv = (m10 * u + m11 * v + o1) * rv;
        if(gu < minGU) minGU = gu; if(gu > maxGU) maxGU = gu;
        if(gv < minGV) minGV = gv; if(gv > maxGV) maxGV = gv;
      }
      if(ok){
        const tolU = hwU + 0.01, tolV = hwV + 0.01;   // ignore feather-sized overhang
        extLoU = minGU < -tolU;  extHiU = maxGU > ru + tolU;
        extLoV = minGV < -tolV;  extHiV = maxGV > rv + tolV;
      }
    }

    for(let ly = 0; ly < bounds.height; ly++){
      for(let lx = 0; lx < bounds.width; lx++){
        const mi = (ly * bounds.width + lx) * 4;
        const maskAlpha = maskData.data[mi + 3] / 255;
        if(maskAlpha <= 0.004) continue;

        const px = bounds.minX + lx + 0.5;
        const py = bounds.minY + ly + 0.5;
        if(excludePolygons.some(poly => Array.isArray(poly) && poly.length >= 3 && pointInPolygon(px, py, poly))) continue;

        // Inverse homography, kept in pieces so the local pixel footprint
        // (how much surface one screen pixel covers) comes out analytically.
        const Xn = ia * px + ib * py + ic;
        const Yn = id * px + ie * py + iff;
        const Wd = ig * px + ih * py + ii;
        const invW = Math.abs(Wd) < 1e-9 ? 1 : 1 / Wd;
        const seedU = Xn * invW, seedV = Yn * invW;
        let u0, v0, du_dx, du_dy, dv_dx, dv_dy;
        if(curvedMapper){
          const uv = invertCurvedMapper(curvedMapper, px, py, seedU, seedV); u0=uv[0]; v0=uv[1];
          const ee=0.0005, p=curvedMapper(u0,v0), pu=curvedMapper(clampN(u0+ee,0,1),v0), pv=curvedMapper(u0,clampN(v0+ee,0,1));
          const a=(pu[0]-p[0])/ee,b=(pv[0]-p[0])/ee,c=(pu[1]-p[1])/ee,d=(pv[1]-p[1])/ee,det=a*d-b*c;
          if(Math.abs(det)>1e-7){ du_dx=d/det; du_dy=-b/det; dv_dx=-c/det; dv_dy=a/det; } else { du_dx=du_dy=dv_dx=dv_dy=0; }
        } else {
          u0=seedU; v0=seedV;
          du_dx = (ia - u0 * ig) * invW; du_dy = (ib - u0 * ih) * invW;
          dv_dx = (id - v0 * ig) * invW; dv_dy = (ie - v0 * ih) * invW;
        }

        const gridU = (m00 * u0 + m01 * v0 + o0) * ru;
        const gridV = (m10 * u0 + m11 * v0 + o1) * rv;
        // half-footprint of one pixel, in tile units, along each lattice axis
        const fwU = Math.min(4, 0.5 * ru * (Math.abs(m00 * du_dx + m01 * dv_dx) + Math.abs(m00 * du_dy + m01 * dv_dy)));
        const fwV = Math.min(4, 0.5 * rv * (Math.abs(m10 * du_dx + m11 * dv_dx) + Math.abs(m10 * du_dy + m11 * dv_dy)));

        const cellU = Math.floor(gridU);
        const cellV = Math.floor(gridV);
        const fu = gridU - cellU;
        const fv = gridV - cellV;

        const oi = mi;
        const or_ = outData.data[oi], og = outData.data[oi + 1], ob = outData.data[oi + 2];

        // Nearest lattice line on each axis, and whether it is an internal joint.
        const kU = Math.round(gridU), kV = Math.round(gridV);
        const dU = Math.abs(gridU - kU), dV = Math.abs(gridV - kV);
        const lineU = (kU >= 1 && kU <= ru - INTERNAL_EPS) || (extLoU && kU <= 0) || (extHiU && kU > ru - INTERNAL_EPS);
        const lineV = (kV >= 1 && kV <= rv - INTERNAL_EPS) || (extLoV && kV <= 0) || (extHiV && kV > rv - INTERNAL_EPS);

        // ---- tile face -------------------------------------------------
        // Sample THIS physical tile face. Adjacent cells are separate tiles;
        // there is no modulo/repeated room-sized texture here. A partial cell
        // simply exposes the corresponding portion of the tile face.
        const localU = clampN((fu - hwU) / Math.max(0.0001, 1 - groutU), 0, 1);
        const localV = clampN((fv - hwV) / Math.max(0.0001, 1 - groutV), 0, 1);

        // Tile Scale changes only the material mapping inside THIS physical
        // tile. It never changes the physical tile grid above. At 1.0 the
        // source texture maps normally; below 1.0 we show a wider portion of
        // the seamless material; above 1.0 we zoom into the material.
        // Wrapping keeps photographic/PBR textures seamless at the edges.
        const sampleU = 0.5 + (localU - 0.5) / textureScale;
        const sampleV = 0.5 + (localV - 0.5) / textureScale;
        const wrappedU = ((sampleU % 1) + 1) % 1;
        const wrappedV = ((sampleV % 1) + 1) % 1;
        const sx = clampN(Math.floor(wrappedU * pw), 0, pw - 1);
        const sy = clampN(Math.floor(wrappedV * ph), 0, ph - 1);
        const si = (sy * pw + sx) * 4;
        const tr = patternData[si], tg = patternData[si + 1], tb = patternData[si + 2];

        // Replace the old floor colour/texture inside the mask. We only use
        // its low-frequency luminance as lighting information, so the old
        // floor pattern does not bleed through the new tile material.
        const origLum = 0.299 * or_ + 0.587 * og + 0.114 * ob;
        const lightFactor = clampN(origLum / avgLum, 0.85, 1.15);
        let ar = clampN(tr * lightFactor, 0, 255);
        let ag = clampN(tg * lightFactor, 0, 255);
        let ab = clampN(tb * lightFactor, 0, 255);

        // Small chamfer on the tile face next to an INTERNAL joint. It is
        // lighting only; the selected texture itself is untouched. The ramp is
        // never narrower than ~1.5 px (and weakened in proportion when it has
        // to be wider), so it stays steady from row to row. No chamfer on the
        // outside edge of the surface - that is not a tile edge.
        let shade = 1;
        if(lineU){
          const bw = Math.max(bevelU, 1.5 * fwU);
          const t = clampN((dU - hwU) / bw, 0, 1);
          shade *= 1 - 0.28 * (1 - t) * (bevelU / bw);
        }
        if(lineV){
          const bw = Math.max(bevelV, 1.5 * fwV);
          const t = clampN((dV - hwV) / bw, 0, 1);
          shade *= 1 - 0.28 * (1 - t) * (bevelV / bw);
        }
        ar *= shade; ag *= shade; ab *= shade;

        // ---- grout joints ----------------------------------------------
        const covU = (lineU && hwU > 0) ? jointCoverage(dU, hwU, fwU) : 0;
        const covV = (lineV && hwV > 0) ? jointCoverage(dV, hwV, fwV) : 0;
        // Joints use a tighter mask than the tile face: the feathered edge is a
        // long soft ramp along shallow floor edges, and a dark line fading out
        // across it reads as grout streaking past the floor into the wall.
        const groutMask = smoothstep(0.35, 0.9, maskAlpha);
        const cov = Math.max(covU, covV) * groutStrength * groutMask;

        if(cov > 0.002){
          // Recessed joint: deepest/darkest at its centre, with a soft bevel
          // at the tile edges. Position across the joint is measured against
          // its rendered width, so the shading is stable when it is sub-pixel.
          const eU = covU > 0 ? clampN(dU / Math.max(hwU, MIN_JOINT_PX * fwU), 0, 1) : 1;
          const eV = covV > 0 ? clampN(dV / Math.max(hwV, MIN_JOINT_PX * fwV), 0, 1) : 1;
          const edge = Math.min(eU, eV);
          const groove = Math.pow(edge, 0.62);

          // Dark centre and lighter bevel near the tile face.
          let bevel;
          if(covU > 0 && covV > 0){
            bevel = 0.84 + 0.16 * edge;
          } else if(covU > 0){
            bevel = gridU >= kU ? 0.78 + 0.22 * eU : 0.92 + 0.08 * eU;
          } else {
            bevel = gridV >= kV ? 0.78 + 0.22 * eV : 0.92 + 0.08 * eV;
          }

          const ambient = clampN(origLum / 180, 0.55, 1.05);
          const groutValue = clampN(deepGrout * (0.7 + 0.9 * groove) * bevel * ambient, 2, 140);

          ar = ar * (1 - cov) + groutValue * cov;
          ag = ag * (1 - cov) + groutValue * cov;
          ab = ab * (1 - cov) + groutValue * cov;
        }

        const a = maskAlpha * clampN(opacity, 0, 1);
        outData.data[oi]     = or_ * (1 - a) + ar * a;
        outData.data[oi + 1] = og * (1 - a) + ag * a;
        outData.data[oi + 2] = ob * (1 - a) + ab * a;
      }
    }

    outCtx.putImageData(outData, bounds.minX, bounds.minY);
  }

  /* Public entry point. `baseImage` = HTMLImageElement/HTMLCanvasElement
     (the untouched original), `layers` = array of layer configs (see
     applyLayer). Always renders from the untouched base, so toggling/
     resetting a surface never compounds artifacts. Returns a Promise
     resolving to a new <canvas>. */
  async function composite(baseImage, layers){
    const w = baseImage.naturalWidth || baseImage.width;
    const h = baseImage.naturalHeight || baseImage.height;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    ctx.drawImage(baseImage, 0, 0, w, h);
    for(const layer of layers){
      if(layer && layer.tileDef) await applyLayer(ctx, w, h, layer);
    }
    return out;
  }

  return { composite, getPattern, whenReady };
})();
