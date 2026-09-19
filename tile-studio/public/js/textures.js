/* ============================================================
   textures.js
   - color helpers
   - procedural <canvas> tile painters (density-aware: a `density`
     multiplier controls how many tile/plank/grout repeats are
     drawn, so the "tile size" slider re-tiles the pattern instead
     of just stretching UVs)
   - Sobel-derived normal maps (real normal maps, not flat bump)
   - roughness map derivation
   ============================================================ */

function hexToRgb(hex){
  const v = hex.replace('#','');
  return { r: parseInt(v.substring(0,2),16), g: parseInt(v.substring(2,4),16), b: parseInt(v.substring(4,6),16) };
}
function clamp(n,a,b){ return Math.max(a,Math.min(b,n)); }
function shadeColor(hex, pct){
  const {r,g,b} = hexToRgb(hex);
  const nr = clamp(r + 255*pct, 0, 255);
  const ng = clamp(g + 255*pct, 0, 255);
  const nb = clamp(b + 255*pct, 0, 255);
  return `rgb(${nr|0},${ng|0},${nb|0})`;
}
function makeCanvas(size){
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  return c;
}

/* Painters below normally bake seam/joint lines into their swatch (slab
   seams, plank gaps, a mosaic grid...). That is right for the 3D scene and
   the AI prompt swatch, where one texture stands in for a stretch of floor.
   Non-AI Photo Mode instead treats a swatch as the face of ONE physical
   tile and draws the real grout itself, from the tile size and the Grout
   slider (see local-tile.js), so it switches `seams` off while painting.
   Otherwise every "60 cm tile" would carry extra horizontal/vertical lines
   through its middle. Default is true: nothing else changes. */
const PAINTER_OPTIONS = { seams: true };

/* ---------- procedural tile texture painters ---------- */
/* `density` (default 1) scales how many repeats/plank rows/grout
   cells are drawn across the same 768px canvas: >1 = smaller,
   more numerous tiles; <1 = larger, fewer tiles. */

function drawMarble(ctx,size,base,vein,density=1){
  ctx.fillStyle = base; ctx.fillRect(0,0,size,size);
  const s = size/512;
  const veinCount = Math.round(14*clamp(density,0.6,1.8));
  for(let i=0;i<veinCount;i++){
    ctx.strokeStyle = shadeColor(vein,(Math.random()-0.5)*0.2);
    ctx.globalAlpha = 0.22+Math.random()*0.3;
    ctx.lineWidth = (0.6+Math.random()*2.4)*s;
    ctx.beginPath();
    let x = Math.random()*size;
    ctx.moveTo(x,0);
    for(let y=0;y<=size;y+=size/8){ x += (Math.random()-0.5)*size*0.22; ctx.lineTo(x,y); }
    ctx.stroke();
  }
  for(let i=0;i<36;i++){
    ctx.fillStyle = shadeColor(base,(Math.random()-0.5)*0.08);
    ctx.globalAlpha = 0.14;
    const r = (6+Math.random()*18)*s;
    ctx.beginPath(); ctx.arc(Math.random()*size,Math.random()*size,r,0,Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  /* slab seam grid so bigger/smaller "slabs" read at different densities */
  const cols = PAINTER_OPTIONS.seams ? Math.max(1, Math.round(2*density)) : 1;
  ctx.strokeStyle = shadeColor(vein,-0.3); ctx.globalAlpha = 0.25; ctx.lineWidth = 1.2*s;
  for(let c=1;c<cols;c++){ const x=c*size/cols; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,size); ctx.stroke(); }
  for(let r=1;r<cols;r++){ const y=r*size/cols; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(size,y); ctx.stroke(); }
  ctx.globalAlpha = 1;
}
function drawGranite(ctx,size,base,colors,density=1){
  ctx.fillStyle = base; ctx.fillRect(0,0,size,size);
  const n = Math.round(size*size*0.012);
  for(let i=0;i<n;i++){
    ctx.fillStyle = colors[(Math.random()*colors.length)|0];
    ctx.globalAlpha = 0.45+Math.random()*0.45;
    const s = (0.6+Math.random()*2.1)*(size/512);
    ctx.fillRect(Math.random()*size, Math.random()*size, s, s);
  }
  ctx.globalAlpha = 1;
  const cols = PAINTER_OPTIONS.seams ? Math.max(1, Math.round(2*density)) : 1;
  ctx.strokeStyle = shadeColor(base,-0.35); ctx.globalAlpha = 0.35; ctx.lineWidth = 1.2*(size/512);
  for(let c=1;c<cols;c++){ const x=c*size/cols; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,size); ctx.stroke(); }
  for(let r=1;r<cols;r++){ const y=r*size/cols; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(size,y); ctx.stroke(); }
  ctx.globalAlpha = 1;
}
function drawWoodPlank(ctx,size,base,grain,density=1){
  ctx.fillStyle = base; ctx.fillRect(0,0,size,size);
  const s = size/512, planks = PAINTER_OPTIONS.seams ? Math.max(2,Math.round(5*density)) : 1, ph = size/planks;
  const gap = PAINTER_OPTIONS.seams ? 2*s : 0;   // no gap strip when the swatch is a single board
  for(let p=0;p<planks;p++){
    const y0 = p*ph;
    ctx.fillStyle = shadeColor(base,(Math.random()-0.5)*0.1);
    ctx.fillRect(0,y0,size,ph-gap);
    for(let i=0;i<9;i++){
      ctx.strokeStyle = shadeColor(grain,(Math.random()-0.5)*0.18);
      ctx.globalAlpha = 0.25+Math.random()*0.3;
      ctx.lineWidth = (0.5+Math.random())*s;
      ctx.beginPath();
      let x=0, y=y0+Math.random()*ph;
      ctx.moveTo(x,y);
      while(x<size){ x += size/12; y += (Math.random()-0.5)*ph*0.14; ctx.lineTo(x,y); }
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = shadeColor(grain,-0.35); ctx.lineWidth = 1.4*s;
  for(let p=1;p<planks;p++){ ctx.beginPath(); ctx.moveTo(0,p*ph); ctx.lineTo(size,p*ph); ctx.stroke(); }
}
function drawHerringbone(ctx,size,base,grain,density=1){
  ctx.fillStyle = grain; ctx.fillRect(0,0,size,size);
  const unit = size/(10*clamp(density,0.6,1.8)), len = unit*3;
  for(let y=-len; y<size+len; y+=unit){
    const flip = Math.round(y/unit)%2===0;
    for(let x=-len; x<size+len; x+=len){
      ctx.save();
      ctx.translate(x+(flip?0:unit), y);
      ctx.rotate(flip? Math.PI/4 : -Math.PI/4);
      ctx.fillStyle = shadeColor(base,(Math.random()-0.5)*0.08);
      ctx.fillRect(0,0,len-unit*0.16, unit-unit*0.16);
      ctx.restore();
    }
  }
}
function drawGroutGrid(ctx,size,base,grout,cols,rows,variance,opts,density=1){
  opts = opts || {};
  if(!PAINTER_OPTIONS.seams){
    // One tile face: flat glaze with the same slight per-tile colour variance,
    // no internal grid. The real joints come from the compositor.
    ctx.fillStyle = shadeColor(base,(Math.random()-0.5)*variance);
    ctx.fillRect(0,0,size,size);
    return;
  }
  cols = Math.max(2, Math.round(cols*density));
  rows = Math.max(2, Math.round(rows*density));
  ctx.fillStyle = grout; ctx.fillRect(0,0,size,size);
  const cw = size/cols, ch = size/rows;
  const gw = Math.max(1, size*0.007);
  for(let r=0;r<rows;r++){
    const offset = (opts.offsetRows && r%2===1) ? cw/2 : 0;
    for(let c=-1;c<cols+1;c++){
      ctx.fillStyle = shadeColor(base,(Math.random()-0.5)*variance);
      const x = c*cw+offset+gw/2, y = r*ch+gw/2;
      ctx.fillRect(x,y,cw-gw,ch-gw);
    }
  }
}
function drawTerrazzo(ctx,size,base,colors,density=1){
  ctx.fillStyle = base; ctx.fillRect(0,0,size,size);
  const n = Math.round(size*size*0.0016*clamp(density,0.6,1.8)), s = size/512;
  for(let i=0;i<n;i++){
    ctx.fillStyle = colors[(Math.random()*colors.length)|0];
    ctx.globalAlpha = 0.65+Math.random()*0.3;
    const cx=Math.random()*size, cy=Math.random()*size, r=(4+Math.random()*9)*s;
    const sides = 5+((Math.random()*3)|0);
    ctx.beginPath();
    for(let k=0;k<sides;k++){
      const ang=(k/sides)*Math.PI*2, rr=r*(0.7+Math.random()*0.6);
      const px=cx+Math.cos(ang)*rr, py=cy+Math.sin(ang)*rr;
      k===0? ctx.moveTo(px,py) : ctx.lineTo(px,py);
    }
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function drawNoiseFlat(ctx,size,base,noise,density=1){
  ctx.fillStyle = base; ctx.fillRect(0,0,size,size);
  const n = Math.round(size*size*0.01), s = size/512;
  for(let i=0;i<n;i++){
    ctx.fillStyle = noise;
    ctx.globalAlpha = 0.03+Math.random()*0.07;
    const sz = (1+Math.random()*2)*s;
    ctx.fillRect(Math.random()*size, Math.random()*size, sz, sz);
  }
  ctx.globalAlpha = 1;
  const cols = PAINTER_OPTIONS.seams ? Math.max(1, Math.round(2*density)) : 1;
  ctx.strokeStyle = shadeColor(noise,-0.2); ctx.globalAlpha = 0.3; ctx.lineWidth = 1.2*s;
  for(let c=1;c<cols;c++){ const x=c*size/cols; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,size); ctx.stroke(); }
  for(let r=1;r<cols;r++){ const y=r*size/cols; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(size,y); ctx.stroke(); }
  ctx.globalAlpha = 1;
}

/* ---------- Sobel-derived normal map ----------
   Real normal maps (not a flat grayscale "bump"): run a Sobel
   gradient over the painted texture's luminance to get per-pixel
   surface tilt, so grout lines / plank seams / vein edges actually
   bend specular highlights depending on view/light angle. */
function makeNormalTexture(colorCanvas, rx, ry, strength=1.6){
  const size = colorCanvas.width;
  const srcCtx = colorCanvas.getContext('2d');
  const src = srcCtx.getImageData(0,0,size,size).data;

  // downsample factor for perf on large canvases — Sobel at full res is fine at 768
  const heights = new Float32Array(size*size);
  for(let i=0;i<size*size;i++){
    const r=src[i*4], g=src[i*4+1], b=src[i*4+2];
    heights[i] = (0.299*r+0.587*g+0.114*b)/255;
  }
  const at = (x,y)=>{
    x = (x+size)%size; y=(y+size)%size; // wrap so tiling seams stay continuous
    return heights[y*size+x];
  };

  const out = makeCanvas(size);
  const octx = out.getContext('2d');
  const img = octx.createImageData(size,size);
  for(let y=0;y<size;y++){
    for(let x=0;x<size;x++){
      const tl=at(x-1,y-1), t=at(x,y-1), tr=at(x+1,y-1);
      const l =at(x-1,y),           r=at(x+1,y);
      const bl=at(x-1,y+1), b=at(x,y+1), br=at(x+1,y+1);
      const gx = (tr+2*r+br) - (tl+2*l+bl);
      const gy = (bl+2*b+br) - (tl+2*t+tr);
      let nx = -gx*strength, ny = -gy*strength, nz = 1.0;
      const len = Math.sqrt(nx*nx+ny*ny+nz*nz);
      nx/=len; ny/=len; nz/=len;
      const idx = (y*size+x)*4;
      img.data[idx]   = ((nx*0.5+0.5)*255)|0;
      img.data[idx+1] = ((ny*0.5+0.5)*255)|0;
      img.data[idx+2] = ((nz*0.5+0.5)*255)|0;
      img.data[idx+3] = 255;
    }
  }
  octx.putImageData(img,0,0);
  const tex = new THREE.CanvasTexture(out);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(rx,ry);
  return tex;
}

function makeRoughnessTexture(colorCanvas, rx, ry, glossy){
  const size = colorCanvas.width;
  const b = makeCanvas(size);
  const bctx = b.getContext('2d');
  bctx.filter = glossy
    ? 'grayscale(1) invert(1) contrast(1.15) brightness(0.85)'
    : 'grayscale(1) contrast(1.05) brightness(1.05)';
  bctx.drawImage(colorCanvas,0,0);
  const tex = new THREE.CanvasTexture(b);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(rx,ry);
  return tex;
}
