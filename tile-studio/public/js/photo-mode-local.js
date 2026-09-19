/* ============================================================
   photo-mode-local.js — Non-AI Mode page logic (Photo Mode's second pane).

   Entirely local: predefined rooms use the fixed quads in
   room-geometry.js, custom uploads use an on-page point-tracing tool,
   and every render goes through local-tile.js's Canvas-based
   perspective compositor. No fetch() to any /api/* route lives in
   this file — nothing here can ever reach Gemini/OpenAI, by
   construction, not just by convention.

   Geometry model: each surface (floor/wall) is a POLYGON, not a plain
   quad. Exactly 4 of its points are "anchors" — those define the
   surface's plane (used to compute the perspective homography, same
   as before). Any extra points a person inserts along an edge are
   "mask-only": they reshape the paint region (e.g. to trace around a
   sofa or table) without changing the plane math. This is what lets
   an irregular, furniture-occluded floor/wall be masked precisely
   instead of forcing everything into one straight-edged quad.

   PERSPECTIVE vs MASK: the mask polygon only decides WHERE tile is painted.
   The tile grid is defined by four anchor corners plus optional points inserted
   along any of the four edges. Extra points bend the grid boundary; a Coons
   surface then carries the tile lattice smoothly through the edited boundary. That matters because the
   real floor corners are usually hidden (behind a sofa) or out of frame, and
   the grid is only undistorted if those four corners are the corners of an
   actual rectangle on the floor. If no plane is set, the mask's four numbered
   corners are used, exactly as before.

   Wrapped in an IIFE so its names never collide with photo-mode.js's
   own top-level identifiers (both files share one global scope, since
   neither is a <script type="module">).
   ============================================================ */
(function(){

  const localSidebar = document.getElementById('localSidebar');
  const localEmptyState = document.getElementById('localEmptyState');
  const localCanvas = document.getElementById('localCanvas');
  const localLoading = document.getElementById('localLoading');
  const localLoadingText = document.getElementById('localLoadingText');
  const localErrorBanner = document.getElementById('localErrorBanner');
  const localUploadInput = document.getElementById('localUploadInput');
  const lctx = localCanvas.getContext('2d');

  let baseImg = null;                    // untouched original photo, natural resolution
  let roomId = null;                     // preset id, or null for an uploaded photo
  // geometry[target] = { points: [{x,y,anchor:boolean}, ...] } | null
  let geometry = { floor: null, wall: null };
  let selection = { floorId: null, wallId: null };
  // Real-world measurements drive the actual repeat count (see
  // rerender()) instead of an abstract "tile size" slider — enter the
  // tile's real dimensions and the surface's real dimensions, and the
  // engine works out how many tiles actually fit.
  function defaultSurfaceControls(){
    return { tileLengthCm: 60, tileWidthCm: 60, surfaceLengthCm: 600, surfaceWidthCm: 600, scaleMult: 1, rotation: 0, grout: 0.5, opacity: 1 };
  }
  let controls = { floor: defaultSurfaceControls(), wall: defaultSurfaceControls() };
  let busy = false;

  // perspective-plane editing state (see startPlaneStep)
  let planePts = null;     // [{x,y,anchor,edge}] — 4 anchors + optional edge points while editing
  let planeTarget = null;  // 'floor' | 'wall'
  let viewOff = { x: 0, y: 0 };  // canvas offset of the photo (non-zero only while the padded plane view is shown)
  const PLANE_PAD = 0.35;  // how far past each photo edge a plane corner may be dragged (fraction of the photo)

  // point-tracing tool state
  let dragPoints = null;   // [{x,y,anchor}] — the polygon currently being edited
  let dragTarget = null;   // 'floor' | 'wall'
  let dragIndex = -1;      // index into dragPoints currently being moved, or -1

  /* ---------- small helpers ---------- */
  function debounce(fn, ms){
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
  function setLocalBusy(isBusy, msg){
    busy = isBusy;
    localLoading.hidden = !isBusy;
    if(msg) localLoadingText.textContent = msg;
    localSidebar.querySelectorAll('button, input').forEach(el => { el.disabled = isBusy; });
  }
  function showLocalError(msg){ localErrorBanner.textContent = msg; localErrorBanner.hidden = false; }
  function clearLocalError(){ localErrorBanner.hidden = true; }
  function showEmptyStage(){ localEmptyState.hidden = false; localCanvas.hidden = true; clearLocalError(); }
  function loadImageFromSrc(src){
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load that image.'));
      img.src = src;
    });
  }
  function drawBaseOnly(){
    viewOff = { x: 0, y: 0 };
    localCanvas.width = baseImg.naturalWidth;
    localCanvas.height = baseImg.naturalHeight;
    lctx.clearRect(0, 0, localCanvas.width, localCanvas.height);
    lctx.drawImage(baseImg, 0, 0);
    localCanvas.hidden = false;
    localEmptyState.hidden = true;
    localCanvas.classList.remove('corner-picking');
  }

  // geometry[target].points -> the 4 plane-anchor corners, in order
  function anchorsOf(geo){ return geo.points.filter(p => p.anchor).map(p => [p.x, p.y]); }
  // ...but the perspective plane, when one has been set, wins (it can lie outside the photo)
  function cornersOf(geo){
    if(geo.plane && geo.plane.length >= 4){
      const a = geo.plane.filter(p => !Array.isArray(p) && p.anchor);
      if(a.length === 4) return a.sort((x,y) => x.index - y.index).map(p => [p.x,p.y]);
      if(geo.plane.length === 4 && Array.isArray(geo.plane[0])) return geo.plane.map(c => [c[0],c[1]]);
    }
    return anchorsOf(geo);
  }
  function planePointsOf(geo){
    if(!geo || !geo.plane || geo.plane.length < 4) return cornersOf(geo).map((p,i) => ({x:p[0],y:p[1],anchor:true,index:i,edge:i}));
    if(Array.isArray(geo.plane[0])) return geo.plane.map((p,i) => ({x:p[0],y:p[1],anchor:i<4,index:i,edge:i<4?i:0}));
    return geo.plane.map((p,i) => ({...p, index: p.index ?? i, edge: p.edge ?? (p.index ?? i)}));
  }
  // geometry[target].points -> the full paint-region polygon (anchors + any inserted points)
  function polygonOf(geo){ return geo.points.map(p => [p.x, p.y]); }

  /* ---------- step 1: picker (mirrors photo-mode.js's picker UI, own state) ---------- */
  function renderLocalPicker(){
    localSidebar.innerHTML = `
      <div class="section-label" style="margin-top:0;">Choose a room photo</div>
      <div class="preset-grid" id="localPresetGrid"></div>
      <div class="preset-divider">or</div>
      <button id="localUploadBtn" class="ai-btn ai-btn-primary">Upload your own photo</button>
      <div class="local-hint">Predefined rooms use built-in floor/wall outlines. An uploaded photo asks you to trace the floor and wall yourself — no AI segmentation, just points you place and drag (and can add more of, to trace around furniture).</div>
    `;
    const grid = document.getElementById('localPresetGrid');
    PRESETS.forEach(p => {
      const card = document.createElement('button');
      card.className = 'preset-card';
      card.innerHTML = `<img src="${p.url}" alt="${p.name}"><span>${p.name}</span>`;
      card.addEventListener('click', () => loadPreset(p));
      grid.appendChild(card);
    });
    document.getElementById('localUploadBtn').addEventListener('click', () => localUploadInput.click());
    showEmptyStage();
    baseImg = null; roomId = null; geometry = { floor: null, wall: null }; selection = { floorId: null, wallId: null };
    controls = { floor: defaultSurfaceControls(), wall: defaultSurfaceControls() };
  }

  async function loadPreset(preset){
    clearLocalError();
    try{
      baseImg = await loadImageFromSrc(preset.url);
      roomId = preset.id;
      const geo = ROOM_GEOMETRY[preset.id];
      geometry = {
        floor: (geo && geo.floor) ? { points: geo.floor.corners.map(c => ({ x: c[0], y: c[1], anchor: true })) } : null,
        wall:  (geo && geo.wall)  ? { points: geo.wall.corners.map(c => ({ x: c[0], y: c[1], anchor: true })) }  : null
      };
      selection = { floorId: null, wallId: null };
      drawBaseOnly();
      renderLocalEditSidebar();
    } catch(err){
      showLocalError(err.message || 'Could not load that preset.');
    }
  }

  localUploadInput.addEventListener('change', async () => {
    const file = localUploadInput.files && localUploadInput.files[0];
    if(!file) return;
    clearLocalError();
    try{
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(file);
      });
      baseImg = await loadImageFromSrc(dataUrl);
      roomId = null;
      geometry = { floor: null, wall: null };
      selection = { floorId: null, wallId: null };
      startCornerStep('floor', true);
    } catch(err){
      showLocalError(err.message || 'Could not read that file.');
    }
    localUploadInput.value = '';
  });

  /* ---------- step 2 (uploads only): point-tracing tool ---------- */
  function defaultQuad(target, w, h){
    const pts = target === 'floor'
      ? [[w*0.08,h*0.62],[w*0.92,h*0.62],[w*0.98,h*0.95],[w*0.02,h*0.95]]
      : [[w*0.05,h*0.05],[w*0.95,h*0.05],[w*0.95,h*0.60],[w*0.05,h*0.60]];
    return pts.map(([x,y]) => ({ x, y, anchor: true }));
  }

  function edgeMidpoints(points){
    const n = points.length;
    return points.map((p, i) => {
      const q = points[(i + 1) % n];
      return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, afterIndex: i };
    });
  }

  function drawCornerOverlay(){
    lctx.clearRect(0, 0, localCanvas.width, localCanvas.height);
    lctx.drawImage(baseImg, 0, 0);
    lctx.save();
    lctx.lineWidth = Math.max(2, localCanvas.width * 0.0025);
    lctx.strokeStyle = '#A9814F';
    lctx.fillStyle = 'rgba(169,129,79,0.18)';
    lctx.beginPath();
    dragPoints.forEach((p, i) => i === 0 ? lctx.moveTo(p.x,p.y) : lctx.lineTo(p.x,p.y));
    lctx.closePath();
    lctx.fill();
    lctx.stroke();

    // "+" insert markers at each edge midpoint
    const plusR = Math.max(7, localCanvas.width * 0.009);
    lctx.font = `${Math.round(plusR * 1.3)}px Inter, sans-serif`;
    lctx.textAlign = 'center'; lctx.textBaseline = 'middle';
    edgeMidpoints(dragPoints).forEach(m => {
      lctx.beginPath();
      lctx.arc(m.x, m.y, plusR, 0, Math.PI*2);
      lctx.fillStyle = 'rgba(30,28,25,0.55)';
      lctx.fill();
      lctx.strokeStyle = 'rgba(237,232,223,0.85)';
      lctx.lineWidth = 1.5;
      lctx.stroke();
      lctx.fillStyle = '#EDE8DF';
      lctx.fillText('+', m.x, m.y + 0.5);
    });

    // point handles — bigger numbered ones for the 4 anchors, small dots for inserted points
    const r = Math.max(8, localCanvas.width * 0.011);
    let anchorNum = 0;
    dragPoints.forEach((p) => {
      if(p.anchor){
        anchorNum++;
        lctx.beginPath();
        lctx.arc(p.x, p.y, r, 0, Math.PI*2);
        lctx.fillStyle = '#EDE8DF';
        lctx.fill();
        lctx.lineWidth = 2.5;
        lctx.strokeStyle = '#A9814F';
        lctx.stroke();
        lctx.fillStyle = '#1C1B19';
        lctx.font = `${Math.round(r)}px Inter, sans-serif`;
        lctx.textAlign = 'center'; lctx.textBaseline = 'middle';
        lctx.fillText(String(anchorNum), p.x, p.y);
      } else {
        lctx.beginPath();
        lctx.arc(p.x, p.y, r * 0.62, 0, Math.PI*2);
        lctx.fillStyle = '#7FB6E8';
        lctx.fill();
        lctx.lineWidth = 2;
        lctx.strokeStyle = '#1C1B19';
        lctx.stroke();
      }
    });
    lctx.restore();
  }

  function canvasPointFromEvent(e){
    const rect = localCanvas.getBoundingClientRect();
    const scaleX = localCanvas.width / rect.width;
    const scaleY = localCanvas.height / rect.height;
    return [(e.clientX - rect.left) * scaleX - viewOff.x, (e.clientY - rect.top) * scaleY - viewOff.y];
  }

  localCanvas.addEventListener('pointerdown', (e) => {
    if(planePts && localCanvas.classList.contains('corner-picking')){
      const [qx, qy] = canvasPointFromEvent(e);
      const planeHit = Math.max(16, baseImg.naturalWidth * 0.03);
      let ni = -1, nb = Infinity;
      planePts.forEach((p, i) => { const d = Math.hypot(p.x - qx, p.y - qy); if(d < nb){ nb = d; ni = i; } });
      if(nb <= planeHit){ dragIndex = ni; localCanvas.setPointerCapture(e.pointerId); return; }
      const plusHitR = Math.max(14, localCanvas.width * 0.022);
      let bestMarker=null,bestMarkerDist=Infinity;
      edgeMidpoints(planePts).forEach(m=>{ const d=Math.hypot(m.x-qx,m.y-qy); if(d<bestMarkerDist){bestMarkerDist=d;bestMarker=m;} });
      if(bestMarker && bestMarkerDist<=plusHitR){
        const insertAt=bestMarker.afterIndex+1;
        const edge=planePts[bestMarker.afterIndex].edge ?? bestMarker.afterIndex;
        planePts.splice(insertAt,0,{x:bestMarker.x,y:bestMarker.y,anchor:false,edge});
        dragIndex=insertAt; localCanvas.setPointerCapture(e.pointerId); drawPlaneOverlay();
      }
      return;
    }
    if(!dragPoints || !localCanvas.classList.contains('corner-picking')) return;
    const [px, py] = canvasPointFromEvent(e);
    const hitR = Math.max(16, localCanvas.width * 0.025);

    // existing points take priority over "+" markers
    let nearest = -1, best = Infinity;
    dragPoints.forEach((p, i) => { const d = Math.hypot(p.x-px, p.y-py); if(d < best){ best = d; nearest = i; } });
    if(best <= hitR){
      dragIndex = nearest;
      localCanvas.setPointerCapture(e.pointerId);
      return;
    }

    // otherwise, check "+" edge-midpoint markers — clicking one inserts
    // a new mask-only point right there, and starts dragging it
    const plusHitR = Math.max(14, localCanvas.width * 0.022);
    let bestMarker = null, bestMarkerDist = Infinity;
    edgeMidpoints(dragPoints).forEach(m => {
      const d = Math.hypot(m.x-px, m.y-py);
      if(d < bestMarkerDist){ bestMarkerDist = d; bestMarker = m; }
    });
    if(bestMarker && bestMarkerDist <= plusHitR){
      const insertAt = bestMarker.afterIndex + 1;
      dragPoints.splice(insertAt, 0, { x: bestMarker.x, y: bestMarker.y, anchor: false });
      dragIndex = insertAt;
      localCanvas.setPointerCapture(e.pointerId);
      drawCornerOverlay();
    }
  });
  localCanvas.addEventListener('pointermove', (e) => {
    if(dragIndex >= 0 && planePts){
      const [qx, qy] = canvasPointFromEvent(e);
      const w = baseImg.naturalWidth, h = baseImg.naturalHeight;
      planePts[dragIndex].x = Math.max(-w * PLANE_PAD, Math.min(w * (1 + PLANE_PAD), qx));
      planePts[dragIndex].y = Math.max(-h * PLANE_PAD, Math.min(h * (1 + PLANE_PAD), qy));
      drawPlaneOverlay();
      return;
    }
    if(dragIndex < 0 || !dragPoints) return;
    const [px, py] = canvasPointFromEvent(e);
    dragPoints[dragIndex].x = Math.max(0, Math.min(localCanvas.width, px));
    dragPoints[dragIndex].y = Math.max(0, Math.min(localCanvas.height, py));
    drawCornerOverlay();
  });
  function endDrag(){ dragIndex = -1; }
  localCanvas.addEventListener('pointerup', endDrag);
  localCanvas.addEventListener('pointercancel', endDrag);
  localCanvas.addEventListener('dblclick', (e) => {
    if(planePts){
      const [qx,qy]=canvasPointFromEvent(e); const hitR=Math.max(16,localCanvas.width*0.025);
      let nearest=-1,best=Infinity; planePts.forEach((p,i)=>{const d=Math.hypot(p.x-qx,p.y-qy);if(d<best){best=d;nearest=i;}});
      if(best<=hitR && nearest>=0 && !planePts[nearest].anchor){ planePts.splice(nearest,1); drawPlaneOverlay(); }
      return;
    }
    if(!dragPoints || !localCanvas.classList.contains('corner-picking')) return;
    const [px, py] = canvasPointFromEvent(e);
    const hitR = Math.max(16, localCanvas.width * 0.025);
    let nearest = -1, best = Infinity;
    dragPoints.forEach((p, i) => { const d = Math.hypot(p.x-px, p.y-py); if(d < best){ best = d; nearest = i; } });
    // only inserted (non-anchor) points can be removed — the 4 anchors
    // define the plane and always stay
    if(best <= hitR && nearest >= 0 && !dragPoints[nearest].anchor){
      dragPoints.splice(nearest, 1);
      drawCornerOverlay();
    }
  });

  function startCornerStep(target, isNewUpload){
    const w = baseImg.naturalWidth, h = baseImg.naturalHeight;
    dragTarget = target;
    planePts = null; viewOff = { x: 0, y: 0 };
    dragPoints = (geometry[target] && geometry[target].points)
      ? geometry[target].points.map(p => ({ ...p }))
      : defaultQuad(target, w, h);

    localCanvas.width = w; localCanvas.height = h;
    localCanvas.hidden = false;
    localEmptyState.hidden = true;
    localCanvas.classList.add('corner-picking');
    drawCornerOverlay();

    localSidebar.innerHTML = `
      <div class="section-label" style="margin-top:0;">Outline the ${target}</div>
      <div class="local-hint">Draw the area that should get tile: drag the numbered corners to the ${target}'s visible edges. If furniture is in the way, click the <b>+</b> on any edge to add a point and drag it around the object — double-click an added point to remove it. Everything outside this shape stays untouched.${isNewUpload ? ' Next you\'ll set the perspective of the tile grid.' : ''}</div>
      <div class="local-btn-row"><button id="cornerConfirm" class="ai-btn ai-btn-primary">Use this ${target} outline</button></div>
      <div class="local-btn-row">
        <button id="cornerSkip" class="ai-btn">Skip — no ${target} tile</button>
        <button id="cornerBack" class="ai-btn">← Back</button>
      </div>
    `;
    document.getElementById('cornerConfirm').addEventListener('click', () => {
      const prevPlane = geometry[target] && geometry[target].plane;
      geometry[target] = { points: dragPoints.map(p => ({ ...p })), plane: prevPlane };
      if(isNewUpload) startPlaneStep(target, true);
      else afterCornerStep(target, false);
    });
    document.getElementById('cornerSkip').addEventListener('click', () => {
      geometry[target] = null;
      afterCornerStep(target, isNewUpload);
    });
    document.getElementById('cornerBack').addEventListener('click', renderLocalPicker);
  }

  function samplePolyline(points, t){
    if(points.length === 1) return [points[0].x, points[0].y];
    const lens=[]; let total=0;
    for(let i=1;i<points.length;i++){ const d=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y); lens.push(d); total+=d; }
    if(total < 1e-6) return [points[0].x,points[0].y];
    let target=Math.max(0,Math.min(1,t))*total;
    for(let i=0;i<lens.length;i++){
      if(target<=lens[i]){ const q=lens[i]<1e-6?0:target/lens[i]; return [points[i].x+(points[i+1].x-points[i].x)*q, points[i].y+(points[i+1].y-points[i].y)*q]; }
      target-=lens[i];
    }
    const p=points[points.length-1]; return [p.x,p.y];
  }
  function buildCurvedGridMapper(points){
    const anchors=points.filter(p=>p.anchor).sort((a,b)=>a.index-b.index);
    if(anchors.length!==4) return null;
    const edges=[0,1,2,3].map(e=>{
      const start=e, end=(e+1)%4;
      const mids=points.filter(p=>!p.anchor && p.edge===e).sort((a,b)=>Math.hypot(a.x-anchors[start].x,a.y-anchors[start].y)-Math.hypot(b.x-anchors[start].x,b.y-anchors[start].y));
      return [{x:anchors[start].x,y:anchors[start].y}, ...mids, {x:anchors[end].x,y:anchors[end].y}];
    });
    if(points.every(p=>p.anchor)) return null;
    return (u,v)=>{
      u=Math.max(0,Math.min(1,u)); v=Math.max(0,Math.min(1,v));
      const T=samplePolyline(edges[0],u);
      const R=samplePolyline(edges[1],v);
      const B=samplePolyline(edges[2],1-u);
      const L=samplePolyline(edges[3],1-v);
      const P00=[anchors[0].x,anchors[0].y], P10=[anchors[1].x,anchors[1].y], P11=[anchors[2].x,anchors[2].y], P01=[anchors[3].x,anchors[3].y];
      return [(1-v)*T[0]+v*B[0]+(1-u)*L[0]+u*R[0]-((1-u)*(1-v)*P00[0]+u*(1-v)*P10[0]+u*v*P11[0]+(1-u)*v*P01[0]),
              (1-v)*T[1]+v*B[1]+(1-u)*L[1]+u*R[1]-((1-u)*(1-v)*P00[1]+u*(1-v)*P10[1]+u*v*P11[1]+(1-u)*v*P01[1])];
    };
  }

  /* ---------- step 2b: perspective plane (4 corners, may be off-photo) ---------- */
  function drawPlaneOverlay(){
    const w = baseImg.naturalWidth, h = baseImg.naturalHeight;
    const ox = viewOff.x, oy = viewOff.y;
    const W = localCanvas.width;
    const unit = Math.max(1, W / 1000);                     // keeps line/handle sizes constant on screen
    lctx.clearRect(0, 0, localCanvas.width, localCanvas.height);
    lctx.fillStyle = '#131211';
    lctx.fillRect(0, 0, localCanvas.width, localCanvas.height);
    lctx.drawImage(baseImg, ox, oy);
    lctx.save();
    lctx.translate(ox, oy);

    // photo border
    lctx.setLineDash([8 * unit, 6 * unit]);
    lctx.lineWidth = 1.5 * unit;
    lctx.strokeStyle = 'rgba(237,232,223,0.45)';
    lctx.strokeRect(0, 0, w, h);
    lctx.setLineDash([]);

    // the painted area (mask), for reference
    const geo = geometry[planeTarget];
    if(geo && geo.points && geo.points.length >= 3){
      lctx.beginPath();
      geo.points.forEach((p, i) => i === 0 ? lctx.moveTo(p.x, p.y) : lctx.lineTo(p.x, p.y));
      lctx.closePath();
      lctx.fillStyle = 'rgba(127,182,232,0.10)';
      lctx.fill();
      lctx.setLineDash([6 * unit, 5 * unit]);
      lctx.lineWidth = 2 * unit;
      lctx.strokeStyle = 'rgba(127,182,232,0.9)';
      lctx.stroke();
      lctx.setLineDash([]);
    }

    // tile-grid preview through the current 4 anchors + optional edge bends
    const quad = planePts.filter(p => p.anchor).sort((a,b) => a.index-b.index).map(p => [p.x, p.y]);
    const H = computeHomography([[0, 0], [1, 0], [1, 1], [0, 1]], quad);
    const gridMap = buildCurvedGridMapper(planePts);
    if(H || gridMap){
      const c = controls[planeTarget];
      const { repeatU, repeatV } = repeatsFor(c);
      const rot = ((Number(c.rotation) || 0) % 360 + 360) % 360;
      const quarter = Math.abs(rot - 90) < 1e-4 || Math.abs(rot - 270) < 1e-4;
      const nAcross = quarter ? repeatV : repeatU;   // joints running along v (constant u)
      const nDown   = quarter ? repeatU : repeatV;   // joints running along u (constant v)
      const flipU = Math.abs(rot - 180) < 1e-4 || Math.abs(rot - 90) < 1e-4;
      const flipV = Math.abs(rot - 180) < 1e-4 || Math.abs(rot - 270) < 1e-4;
      const drawCurve = (constant, vertical) => {
        const steps = gridMap ? 32 : 1;
        for(let s=0;s<=steps;s++){
          const t=s/steps;
          const uv=vertical ? [constant,t] : [t,constant];
          const q=gridMap ? gridMap(uv[0],uv[1]) : applyHomography(H,uv[0],uv[1]);
          if(s===0) lctx.moveTo(q[0],q[1]); else lctx.lineTo(q[0],q[1]);
        }
      };
      lctx.beginPath();
      for(let k = 1; k < nAcross - 1e-4 && k <= 80; k++){ const u = flipU ? 1 - k / nAcross : k / nAcross; drawCurve(u,true); }
      for(let k = 1; k < nDown - 1e-4 && k <= 80; k++){ const v = flipV ? 1 - k / nDown : k / nDown; drawCurve(v,false); }
      lctx.lineWidth = 1.6 * unit;
      lctx.strokeStyle = 'rgba(0,0,0,0.55)';
      lctx.stroke();
      lctx.lineWidth = 0.9 * unit;
      lctx.strokeStyle = 'rgba(95,208,192,0.95)';
      lctx.stroke();
    }

    // + markers along every editable plane edge
    const plusR = Math.max(7, localCanvas.width * 0.009);
    lctx.font = `${Math.round(plusR * 1.3)}px Inter, sans-serif`; lctx.textAlign='center'; lctx.textBaseline='middle';
    edgeMidpoints(planePts).forEach(m=>{ lctx.beginPath(); lctx.arc(m.x,m.y,plusR,0,Math.PI*2); lctx.fillStyle='#5FD0C0'; lctx.fill(); lctx.fillStyle='#10100F'; lctx.fillText('+',m.x,m.y+0.5); });

    // perspective boundary + handles
    lctx.beginPath();
    planePts.forEach((p, i) => i === 0 ? lctx.moveTo(p.x, p.y) : lctx.lineTo(p.x, p.y));
    lctx.closePath();
    lctx.lineWidth = 2.5 * unit;
    lctx.strokeStyle = '#5FD0C0';
    lctx.stroke();
    const r = 11 * unit;
    planePts.forEach((p) => {
      if(p.anchor){
        lctx.beginPath(); lctx.arc(p.x,p.y,r,0,Math.PI*2);
        lctx.fillStyle='#EDE8DF'; lctx.fill(); lctx.lineWidth=3*unit; lctx.strokeStyle='#5FD0C0'; lctx.stroke();
        lctx.fillStyle='#1C1B19'; lctx.font=`600 ${Math.round(r*1.1)}px Inter, sans-serif`; lctx.textAlign='center'; lctx.textBaseline='middle';
        lctx.fillText(String((p.index ?? 0)+1),p.x,p.y+0.5);
      } else {
        lctx.beginPath(); lctx.arc(p.x,p.y,r*0.62,0,Math.PI*2); lctx.fillStyle='#7FB6E8'; lctx.fill(); lctx.lineWidth=2*unit; lctx.strokeStyle='#1C1B19'; lctx.stroke();
      }
    });
    lctx.restore();
  }

  function startPlaneStep(target, isNewUpload){
    const w = baseImg.naturalWidth, h = baseImg.naturalHeight;
    const geo = geometry[target];
    planeTarget = target;
    dragPoints = null; dragIndex = -1;
    planePts = planePointsOf(geo);
    viewOff = { x: Math.round(w * PLANE_PAD), y: Math.round(h * PLANE_PAD) };
    localCanvas.width = w + 2 * viewOff.x;
    localCanvas.height = h + 2 * viewOff.y;
    localCanvas.hidden = false;
    localEmptyState.hidden = true;
    localCanvas.classList.add('corner-picking');
    drawPlaneOverlay();

    localSidebar.innerHTML = `
      <div class="section-label" style="margin-top:0;">Set the ${target} perspective</div>
      <div class="local-hint">Drag the four corners onto the corners of the <b>real ${target} rectangle</b> (${target === 'floor' ? '1 = far-left, 2 = far-right, 3 = near-right, 4 = near-left' : '1 = top-left, 2 = top-right, 3 = bottom-right, 4 = bottom-left'}). Click <b>+</b> on any edge to insert extra perspective points; drag them to bend that edge. Double-click an added point to remove it. They can be hidden behind furniture or <b>outside the photo</b> — just drag past the edge. The teal grid follows the bent perspective surface; the blue dashed area is what actually gets painted.</div>
      <div class="local-btn-row"><button id="planeConfirm" class="ai-btn ai-btn-primary">Use this perspective</button></div>
      <div class="local-btn-row">
        <button id="planeReset" class="ai-btn">Reset to outline corners</button>
        <button id="planeBack" class="ai-btn">← Back</button>
      </div>
    `;
    document.getElementById('planeConfirm').addEventListener('click', () => {
      // Preserve anchor/index/edge metadata. Storing only [x,y] here loses
      // which extra point belongs to which edge, so the curved/multi-point
      // perspective mapper cannot reconstruct the grid after confirmation.
      geometry[target].plane = planePts.map(p => ({
        x: p.x, y: p.y, anchor: !!p.anchor,
        index: p.index ?? null, edge: p.edge ?? null
      }));
      planePts = null;
      afterCornerStep(target, isNewUpload);
    });
    document.getElementById('planeReset').addEventListener('click', () => {
      planePts = anchorsOf(geometry[target]).map(([x, y], i) => ({ x, y, anchor:true, index:i, edge:i }));
      drawPlaneOverlay();
    });
    document.getElementById('planeBack').addEventListener('click', () => {
      planePts = null;
      if(isNewUpload) startCornerStep(target, true);
      else { drawBaseOnly(); renderLocalEditSidebar(); rerender(); }
    });
  }

  function afterCornerStep(target, isNewUpload){
    if(target === 'floor' && isNewUpload){
      startCornerStep('wall', true);
    } else {
      planePts = null; viewOff = { x: 0, y: 0 };
      localCanvas.classList.remove('corner-picking');
      renderLocalEditSidebar();
      rerender();
    }
  }

  /* ---------- step 3: edit sidebar (tile swatches + controls) ---------- */
  const NONE_ID = '__none__';
  function tileSwatchGrid(container, tiles, selectedId, onSelect){
    container.innerHTML = '';

    // "None" always comes first — an explicit way to lift a tile back
    // off a surface (vs. the global "Reset to original photo" button,
    // which clears both surfaces at once).
    const noneBtn = document.createElement('button');
    noneBtn.className = 'swatch none-swatch' + (selectedId == null ? ' selected' : '');
    noneBtn.textContent = 'None';
    noneBtn.title = 'Remove the tile from this surface';
    noneBtn.addEventListener('click', () => onSelect(null));
    container.appendChild(noneBtn);

    tiles.forEach(t => {
      const btn = document.createElement('button');
      btn.className = 'swatch' + (t.id === selectedId ? ' selected' : '');
      const c = document.createElement('canvas');
      c.width = 96; c.height = 96;
      if(t.photo){
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#3A372F'; ctx.fillRect(0,0,96,96);
        const img = new Image();
        img.onload = () => { ctx.drawImage(img,0,0,96,96); };
        img.src = t.photo.base + t.photo.diffuse;
      } else {
        t.paint(c.getContext('2d'), 96, 1);
      }
      const label = document.createElement('div');
      label.className = 'swatch-name';
      label.textContent = t.name;
      btn.appendChild(c); btn.appendChild(label);
      btn.addEventListener('click', () => onSelect(t));
      container.appendChild(btn);
    });
  }
  function sliderRow(id, label, min, max, step, val){
    return `<div class="slider-row"><label for="${id}">${label}</label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"></div>`;
  }
  function numberField(id, label, val, opts){
    opts = opts || {};
    const min = opts.min != null ? ` min="${opts.min}"` : '';
    const max = opts.max != null ? ` max="${opts.max}"` : '';
    const step = opts.step != null ? opts.step : 1;
    return `<div class="field"><label for="${id}">${label}</label><input type="number" id="${id}" value="${val}" step="${step}"${min}${max}></div>`;
  }

  function surfaceControlsMarkup(prefix, surfaceLabel, c){
    return `
      <div class="field-group-label">${surfaceLabel} size</div>
      <div class="field-pair">
        ${numberField(prefix+'Len','Length (cm)', c.surfaceLengthCm, {min:1,step:1})}
        ${numberField(prefix+'Wid','Width (cm)', c.surfaceWidthCm, {min:1,step:1})}
      </div>
      <div class="field-group-label">Tile size</div>
      <div class="field-pair">
        ${numberField(prefix+'TileLen','Length (cm)', c.tileLengthCm, {min:1,step:1})}
        ${numberField(prefix+'TileWid','Width (cm)', c.tileWidthCm, {min:1,step:1})}
      </div>
      ${sliderRow(prefix+'ScaleL','Tile scale',0.5,2,0.05,c.scaleMult)}
      ${numberField(prefix+'RotL','Rotation °', c.rotation, {min:0,max:359,step:1})}
      ${sliderRow(prefix+'GroutL','Grout',0,1,0.05,c.grout)}
      ${sliderRow(prefix+'OpL','Strength',0.5,1,0.02,c.opacity)}
    `;
  }

  function renderLocalEditSidebar(){
    const hasFloor = !!geometry.floor, hasWall = !!geometry.wall;
    const custom = roomId === null;
    localSidebar.innerHTML = `
      <button id="localBackToPicker" class="ai-btn" style="width:100%;">← Choose a different photo</button>

      ${hasFloor ? `
      <div class="local-surface-block">
        <div class="section-label">Floor tiles</div>
        <div class="swatch-grid" id="localFloorGrid"></div>
        ${surfaceControlsMarkup('floor', 'Floor', controls.floor)}
        ${custom ? `<div class="local-btn-row"><button id="floorAdjustPts" class="ai-btn">Adjust floor outline</button><button id="floorPlanePts" class="ai-btn">Perspective grid</button></div>` : ''}
      </div>` : (custom ? `<div class="local-surface-block"><div class="local-hint" style="margin:0 0 8px;">No floor outline defined.</div><button id="floorAddPts" class="ai-btn" style="width:100%;">Trace the floor</button></div>` : `<div class="local-hint">This photo has no floor outline.</div>`)}

      ${hasWall ? `
      <div class="local-surface-block">
        <div class="section-label">Wall tiles</div>
        <div class="swatch-grid" id="localWallGrid"></div>
        ${surfaceControlsMarkup('wall', 'Wall', controls.wall)}
        ${custom ? `<div class="local-btn-row"><button id="wallAdjustPts" class="ai-btn">Adjust wall outline</button><button id="wallPlanePts" class="ai-btn">Perspective grid</button></div>` : ''}
      </div>` : (custom ? `<div class="local-surface-block"><div class="local-hint" style="margin:0 0 8px;">No wall outline defined.</div><button id="wallAddPts" class="ai-btn" style="width:100%;">Trace the wall</button></div>` : `<div class="local-hint">This photo has no wall outline.</div>`)}

      <button id="localReset" class="ai-btn" style="width:100%; margin-top:18px;">Reset to original photo</button>
      <button id="localDownload" class="ai-btn ai-btn-primary" style="width:100%; margin-top:8px;">Download result</button>
      <div class="local-hint">Runs entirely in your browser — perspective-correct tile compositing over the real photo. No AI call, nothing leaves your machine.</div>
    `;

    document.getElementById('localBackToPicker').addEventListener('click', renderLocalPicker);
    document.getElementById('localReset').addEventListener('click', () => {
      if(busy) return;
      selection = { floorId: null, wallId: null };
      drawBaseOnly();
      refreshLocalGrids();
    });
    document.getElementById('localDownload').addEventListener('click', downloadLocalResult);

    if(hasFloor){
      wireSurfaceControls('floor', controls.floor);
      const adj = document.getElementById('floorAdjustPts');
      if(adj) adj.addEventListener('click', () => startCornerStep('floor', false));
      const pl = document.getElementById('floorPlanePts');
      if(pl) pl.addEventListener('click', () => startPlaneStep('floor', false));
    }
    const floorAdd = document.getElementById('floorAddPts');
    if(floorAdd) floorAdd.addEventListener('click', () => startCornerStep('floor', false));

    if(hasWall){
      wireSurfaceControls('wall', controls.wall);
      const adj = document.getElementById('wallAdjustPts');
      if(adj) adj.addEventListener('click', () => startCornerStep('wall', false));
      const pl = document.getElementById('wallPlanePts');
      if(pl) pl.addEventListener('click', () => startPlaneStep('wall', false));
    }
    const wallAdd = document.getElementById('wallAddPts');
    if(wallAdd) wallAdd.addEventListener('click', () => startCornerStep('wall', false));

    refreshLocalGrids();
  }

  function wireSurfaceControls(prefix, c){
    wireNumber(prefix+'Len',     v => c.surfaceLengthCm = v, 1);
    wireNumber(prefix+'Wid',     v => c.surfaceWidthCm = v, 1);
    wireNumber(prefix+'TileLen', v => c.tileLengthCm = v, 1);
    wireNumber(prefix+'TileWid', v => c.tileWidthCm = v, 1);
    wireSlider(prefix+'ScaleL',  v => c.scaleMult = v);
    wireNumber(prefix+'RotL',    v => c.rotation = ((v % 360) + 360) % 360, 0);
    wireSlider(prefix+'GroutL',  v => c.grout = v);
    wireSlider(prefix+'OpL',     v => c.opacity = v);
  }
  function wireSlider(id, apply){
    const el = document.getElementById(id);
    el.addEventListener('input', debounce(() => { apply(parseFloat(el.value)); rerender(); }, 110));
  }
  function wireNumber(id, apply, minVal){
    const el = document.getElementById(id);
    el.addEventListener('input', debounce(() => {
      const v = parseFloat(el.value);
      if(Number.isFinite(v) && v >= minVal) { apply(v); rerender(); }
    }, 180));
  }

  function refreshLocalGrids(){
    if(geometry.floor){
      tileSwatchGrid(document.getElementById('localFloorGrid'), [...FLOOR_TILES, ...CUSTOM_FLOOR_TILES], selection.floorId, (t) => {
        selection.floorId = t ? t.id : null; rerender(); refreshLocalGrids();
      });
    }
    if(geometry.wall){
      tileSwatchGrid(document.getElementById('localWallGrid'), [...WALL_TILES, ...CUSTOM_WALL_TILES], selection.wallId, (t) => {
        selection.wallId = t ? t.id : null; rerender(); refreshLocalGrids();
      });
    }
  }

  /* ---------- rendering ---------- */
  // Real cm measurements determine the physical tile count. Tile Scale is
  // deliberately NOT part of this calculation: changing it must never
  // change tile dimensions, tile count, grout spacing, or perspective.
  //
  // repeatU / repeatV are counts along the TILE's own axes (U = tile width,
  // V = tile length). At 0 and 180 degrees those run along the surface's
  // width and length respectively. A quarter turn (90 / 270) swaps them: the
  // tile width now runs along the surface LENGTH, and the tile length along
  // the surface WIDTH. Without the swap a non-square surface gets the wrong
  // number of joints (e.g. 400 x 600 cm of 60 cm tiles at 90 degrees showed
  // 6 rows and 9 columns instead of 9 rows and 6 columns). On a square
  // surface the two are identical, which is why it went unnoticed.
  function repeatsFor(c){
    const rot = ((Number(c.rotation) || 0) % 360 + 360) % 360;
    const quarterTurn = Math.abs(rot - 90) < 1e-4 || Math.abs(rot - 270) < 1e-4;
    const alongU = quarterTurn ? c.surfaceLengthCm : c.surfaceWidthCm;
    const alongV = quarterTurn ? c.surfaceWidthCm  : c.surfaceLengthCm;
    const repeatU = alongU / Math.max(1, c.tileWidthCm);
    const repeatV = alongV / Math.max(1, c.tileLengthCm);
    return { repeatU, repeatV };
  }

  async function rerender(){
    if(!baseImg || busy) return;
    clearLocalError();
    setLocalBusy(true, 'Rendering tiles…');
    try{
      const layers = [];
      if(geometry.wall && selection.wallId){
        const t = [...WALL_TILES, ...CUSTOM_WALL_TILES].find(x => x.id === selection.wallId);
        if(t){
          const { repeatU, repeatV } = repeatsFor(controls.wall);
          layers.push({ corners: cornersOf(geometry.wall), perspectivePoints: planePointsOf(geometry.wall), maskPoints: polygonOf(geometry.wall), tileDef: t, repeatU, repeatV, rotationDeg: controls.wall.rotation, grout: controls.wall.grout, opacity: controls.wall.opacity, feather: 6, tileLengthCm: controls.wall.tileLengthCm, tileWidthCm: controls.wall.tileWidthCm, materialScale: controls.wall.scaleMult });
        }
      }
      if(geometry.floor && selection.floorId){
        const t = [...FLOOR_TILES, ...CUSTOM_FLOOR_TILES].find(x => x.id === selection.floorId);
        if(t){
          const { repeatU, repeatV } = repeatsFor(controls.floor);
          layers.push({ corners: cornersOf(geometry.floor), perspectivePoints: planePointsOf(geometry.floor), maskPoints: polygonOf(geometry.floor), tileDef: t, repeatU, repeatV, rotationDeg: controls.floor.rotation, grout: controls.floor.grout, opacity: controls.floor.opacity, feather: 6, tileLengthCm: controls.floor.tileLengthCm, tileWidthCm: controls.floor.tileWidthCm, materialScale: controls.floor.scaleMult });
        }
      }
      if(layers.length === 0){ drawBaseOnly(); return; }

      const result = await LocalTileEngine.composite(baseImg, layers);
      localCanvas.width = result.width;
      localCanvas.height = result.height;
      lctx.drawImage(result, 0, 0);
      localCanvas.hidden = false;
      localEmptyState.hidden = true;
      localCanvas.classList.remove('corner-picking');
    } catch(err){
      console.error('[local-tile]', err);
      showLocalError(err.message || 'Local rendering failed. Nothing was sent anywhere — this ran entirely in your browser.');
    } finally {
      setLocalBusy(false);
    }
  }

  function downloadLocalResult(){
    if(localCanvas.hidden){ showLocalError('Nothing to download yet — pick at least one tile first.'); return; }
    const a = document.createElement('a');
    a.href = localCanvas.toDataURL('image/png');
    a.download = `tile-studio-${roomId || 'custom-room'}-local.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  renderLocalPicker();
})();
