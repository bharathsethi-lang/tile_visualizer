/* ============================================================
   photo-mode.js — AI Photo Mode

   IMPORTANT ARCHITECTURE:
   1) AI analyzes the room and returns surface geometry only.
   2) Tile Studio's deterministic LocalTileEngine places the exact
      selected catalog tile using that geometry.
   3) Optional [AI TOUCH-UP] asks the selected AI provider for a
      photographic reference, but the browser transfers ONLY a
      tightly-clamped lighting/luminance adjustment back onto the
      deterministic render. The AI image is never used as the tile layer.
   ============================================================ */

const PRESETS = [
  { id:'living-room', name:'Living room', url:'assets/presets/living-room.jpg' },
  { id:'bathroom', name:'Bathroom', url:'assets/presets/bathroom.jpg' },
  { id:'bedroom', name:'Bedroom', url:'assets/presets/bedroom.jpg' },
];

const sidebar = document.getElementById('photoSidebar');
const photoImage = document.getElementById('photoImage');
const photoEmptyState = document.getElementById('photoEmptyState');
const photoLoading = document.getElementById('photoLoading');
const photoLoadingText = document.getElementById('photoLoadingText');
const photoErrorBanner = document.getElementById('photoErrorBanner');
const photoUploadInput = document.getElementById('photoUploadInput');

let baseImageSrc = null;
let baseImg = null;
let analysis = null;
let selectedFloorId = null;
let selectedWallId = null;
let selectedAIProvider = localStorage.getItem('tileStudioAIProvider') || 'huggingface';
let deterministicCanvas = null;
let currentDisplaySrc = null;
let busy = false;

const defaultControls = () => ({
  tileLengthCm: 60,
  tileWidthCm: 60,
  surfaceLengthCm: 600,
  surfaceWidthCm: 600,
  rotation: 0,
  grout: 0.5,
  opacity: 1,
  scaleMult: 1
});
let controls = { floor: defaultControls(), wall: defaultControls() };

function setBusy(v, msg){
  busy = v;
  photoLoading.hidden = !v;
  if(msg) photoLoadingText.textContent = msg;
  sidebar.querySelectorAll('button,input,select').forEach(el => el.disabled = v);
}
function showError(msg){ photoErrorBanner.textContent = msg; photoErrorBanner.hidden = false; }
function clearError(){ photoErrorBanner.hidden = true; }

function blobUrlToDataURL(url){
  return fetch(url).then(r=>r.blob()).then(blob=>new Promise((resolve,reject)=>{
    const reader=new FileReader(); reader.onload=()=>resolve(reader.result); reader.onerror=()=>reject(new Error('Could not read that image.')); reader.readAsDataURL(blob);
  }));
}
function loadImage(src){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>resolve(img);
    img.onerror=()=>reject(new Error('Could not load that image.'));
    img.src=src;
  });
}

function setBaseImage(dataUrl){
  baseImageSrc = dataUrl;
  currentDisplaySrc = dataUrl;
  analysis = null;
  deterministicCanvas = null;
  selectedFloorId = null;
  selectedWallId = null;
  controls = { floor: defaultControls(), wall: defaultControls() };
  photoImage.src = dataUrl;
  photoImage.hidden = false;
  photoEmptyState.hidden = true;
  clearError();
  loadImage(dataUrl).then(img=>{ baseImg=img; renderAnalysisSidebar(); analyzeRoom(); }).catch(err=>showError(err.message));
}

function renderPickerSidebar(){
  sidebar.innerHTML = `
    <div class="section-label" style="margin-top:0;">Choose a room photo</div>
    <div class="preset-grid" id="presetGrid"></div>
    <div class="preset-divider">or</div>
    <button id="uploadBtn" class="ai-btn ai-btn-primary">Upload your own photo</button>
    <div class="ai-block-sub" style="margin-top:10px;">AI Mode uses AI for room geometry only. Tile placement is always done by Tile Studio software.</div>
  `;
  const grid=document.getElementById('presetGrid');
  PRESETS.forEach(p=>{
    const card=document.createElement('button'); card.className='preset-card';
    card.innerHTML=`<img src="${p.url}" alt="${p.name}"><span>${p.name}</span>`;
    card.addEventListener('click',async()=>{ try{ setBaseImage(await blobUrlToDataURL(p.url)); }catch(err){showError(err.message);} });
    grid.appendChild(card);
  });
  document.getElementById('uploadBtn').addEventListener('click',()=>photoUploadInput.click());
}

photoUploadInput.addEventListener('change',()=>{
  const file=photoUploadInput.files?.[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=()=>setBaseImage(reader.result);
  reader.onerror=()=>showError('Could not read that file.');
  reader.readAsDataURL(file);
  photoUploadInput.value='';
});

function providerMarkup(){
  return `
    <div class="section-label">AI analysis provider</div>
    <select id="aiProviderSelect" class="ai-select" style="width:100%; margin-bottom:8px;">
      <option value="huggingface">Hugging Face</option>
      <option value="gemini">Gemini</option>
      <option value="openai">OpenAI</option>
    </select>
    <div class="ai-block-sub" style="margin-bottom:12px;">AI finds the surfaces and perspective. It does not paint the tile.</div>
  `;
}

function renderAnalysisSidebar(){
  sidebar.innerHTML = `
    <button id="backToPicker" class="ai-btn" style="width:100%;">← Choose a different photo</button>
    ${providerMarkup()}
    <button id="reanalyzeBtn" class="ai-btn ai-btn-primary" style="width:100%;">Analyze room</button>
    <div id="analysisStatus" class="ai-block-sub" style="margin:10px 0 16px;">Waiting for analysis…</div>
    <div id="aiSurfaceControls"></div>
  `;
  document.getElementById('backToPicker').addEventListener('click',renderPickerSidebar);
  const select=document.getElementById('aiProviderSelect');
  select.value=selectedAIProvider;
  select.addEventListener('change',()=>{
    selectedAIProvider=select.value;
    localStorage.setItem('tileStudioAIProvider',selectedAIProvider);
    analyzeRoom();
  });
  document.getElementById('reanalyzeBtn').addEventListener('click',analyzeRoom);
  renderSurfaceControls();
}

async function analyzeRoom(){
  if(!baseImageSrc || busy) return;
  clearError();
  const status=document.getElementById('analysisStatus');
  if(status) status.textContent=`Analyzing room with ${selectedAIProvider}…`;
  setBusy(true,'Analyzing room geometry…');
  try{
    const res=await fetch('/api/analyze-room',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseImage:baseImageSrc,provider:selectedAIProvider})});
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||`Server returned ${res.status}`);
    analysis=data.analysis;
    selectedFloorId=null; selectedWallId=null;
    deterministicCanvas=null;
    if(status) status.textContent=`Detected: ${[analysis.floor?'floor':null,analysis.wall?'wall':null].filter(Boolean).join(' + ') || 'nothing usable'}. Review the detected geometry, then choose a tile.`;
    renderSurfaceControls();
  }catch(err){
    if(status) status.textContent='Analysis failed.';
    showError(err.message||'Room analysis failed. You can switch to Non-AI or Manual mode.');
  }finally{ setBusy(false); }
}

function allFloorTiles(){ return [...FLOOR_TILES,...CUSTOM_FLOOR_TILES]; }
function allWallTiles(){ return [...WALL_TILES,...CUSTOM_WALL_TILES]; }

function swatchGrid(container,tiles,selectedId,onSelect){
  container.innerHTML='';
  tiles.forEach(t=>{
    const btn=document.createElement('button'); btn.className='swatch'+(t.id===selectedId?' selected':'');
    const c=document.createElement('canvas'); c.width=96;c.height=96;
    if(t.photo){
      const ctx=c.getContext('2d');ctx.fillStyle='#3A372F';ctx.fillRect(0,0,96,96);
      const img=new Image();img.onload=()=>ctx.drawImage(img,0,0,96,96);img.src=t.photo.base+t.photo.diffuse;
    }else t.paint(c.getContext('2d'),96,1);
    const label=document.createElement('div');label.className='swatch-name';label.textContent=t.name;
    btn.append(c,label);btn.addEventListener('click',()=>onSelect(t));container.appendChild(btn);
  });
}
function numberField(id,label,val){ return `<div class="field"><label for="${id}">${label}</label><input type="number" id="${id}" value="${val}" min="1" step="1"></div>`; }
function surfaceControls(prefix,label,c){
  return `
    <div class="local-surface-block">
      <div class="section-label">${label} tiles</div>
      <div class="swatch-grid" id="${prefix}Grid"></div>
      <div class="field-group-label">Real-world surface size</div>
      <div class="field-pair">${numberField(prefix+'SurfaceLen','Length (cm)',c.surfaceLengthCm)}${numberField(prefix+'SurfaceWid','Width (cm)',c.surfaceWidthCm)}</div>
      <div class="field-group-label">Tile size</div>
      <div class="field-pair">${numberField(prefix+'TileLen','Length (cm)',c.tileLengthCm)}${numberField(prefix+'TileWid','Width (cm)',c.tileWidthCm)}</div>
      <div class="field-pair">
        <div class="field"><label for="${prefix}Rot">Rotation °</label><input type="number" id="${prefix}Rot" value="${c.rotation}" min="0" max="359" step="1"></div>
        <div class="field"><label for="${prefix}Grout">Grout</label><input type="range" id="${prefix}Grout" min="0" max="1" step="0.05" value="${c.grout}"></div>
      </div>
    </div>`;
}

function renderSurfaceControls(){
  const host=document.getElementById('aiSurfaceControls'); if(!host) return;
  if(!analysis){ host.innerHTML=''; return; }
  host.innerHTML=`
    ${analysis.floor?surfaceControls('floor','Floor',controls.floor):'<div class="ai-block-sub">No floor surface detected.</div>'}
    ${analysis.wall?surfaceControls('wall','Wall',controls.wall):'<div class="ai-block-sub">No wall surface detected.</div>'}
    <button id="aiTouchupBtn" class="ai-btn ai-btn-primary" style="width:100%; margin-top:12px;" disabled>AI TOUCH-UP</button>
    <div class="ai-block-sub" style="margin-top:8px;">Touch-up is optional. It is used only as a lighting/shadow reference; the exact software-rendered tile stays protected.</div>
    <button id="aiDownload" class="ai-btn" style="width:100%; margin-top:8px;">Download result</button>
  `;
  if(analysis.floor){
    swatchGrid(document.getElementById('floorGrid'),allFloorTiles(),selectedFloorId,t=>{selectedFloorId=t.id;renderSurfaceControls();rerenderAI();});
    wireSurface('floor',controls.floor);
  }
  if(analysis.wall){
    swatchGrid(document.getElementById('wallGrid'),allWallTiles(),selectedWallId,t=>{selectedWallId=t.id;renderSurfaceControls();rerenderAI();});
    wireSurface('wall',controls.wall);
  }
  const touch=document.getElementById('aiTouchupBtn'); if(touch) touch.addEventListener('click',aiTouchup);
  const dl=document.getElementById('aiDownload'); if(dl) dl.addEventListener('click',downloadResult);
  if(deterministicCanvas && touch) touch.disabled=false;
}

function wireSurface(prefix,c){
  const pairs=[['SurfaceLen','surfaceLengthCm'],['SurfaceWid','surfaceWidthCm'],['TileLen','tileLengthCm'],['TileWid','tileWidthCm'],['Rot','rotation']];
  pairs.forEach(([id,key])=>{const el=document.getElementById(prefix+id);if(!el)return;el.addEventListener('change',()=>{c[key]=parseFloat(el.value)||c[key];rerenderAI();});});
  const g=document.getElementById(prefix+'Grout'); if(g) g.addEventListener('input',()=>{c.grout=parseFloat(g.value);rerenderAI();});
}

function toPxSurface(s){
  if(!s || !baseImg) return null;
  const W=baseImg.naturalWidth,H=baseImg.naturalHeight;
  const point=p=>[p[0]*W,p[1]*H];
  return {
    polygon:s.polygon.map(point),
    corners:s.corners.map(point),
    obstacles:(s.obstacles||[]).map(poly=>poly.map(point))
  };
}
function repeatsFor(c){
  const r=((Number(c.rotation)||0)%360+360)%360;
  const q=Math.abs(r-90)<1e-4||Math.abs(r-270)<1e-4;
  return {repeatU:(q?c.surfaceLengthCm:c.surfaceWidthCm)/Math.max(1,c.tileWidthCm),repeatV:(q?c.surfaceWidthCm:c.surfaceLengthCm)/Math.max(1,c.tileLengthCm)};
}

async function rerenderAI(){
  if(!baseImg || !analysis || busy) return;
  const layers=[];
  if(analysis.floor && selectedFloorId){
    const t=allFloorTiles().find(x=>x.id===selectedFloorId), s=toPxSurface(analysis.floor); const r=repeatsFor(controls.floor);
    if(t&&s) layers.push({corners:s.corners,maskPoints:s.polygon,excludePolygons:s.obstacles,tileDef:t,repeatU:r.repeatU,repeatV:r.repeatV,rotationDeg:controls.floor.rotation,grout:controls.floor.grout,opacity:controls.floor.opacity,feather:6,tileLengthCm:controls.floor.tileLengthCm,tileWidthCm:controls.floor.tileWidthCm,materialScale:controls.floor.scaleMult});
  }
  if(analysis.wall && selectedWallId){
    const t=allWallTiles().find(x=>x.id===selectedWallId), s=toPxSurface(analysis.wall); const r=repeatsFor(controls.wall);
    if(t&&s) layers.push({corners:s.corners,maskPoints:s.polygon,excludePolygons:s.obstacles,tileDef:t,repeatU:r.repeatU,repeatV:r.repeatV,rotationDeg:controls.wall.rotation,grout:controls.wall.grout,opacity:controls.wall.opacity,feather:6,tileLengthCm:controls.wall.tileLengthCm,tileWidthCm:controls.wall.tileWidthCm,materialScale:controls.wall.scaleMult});
  }
  if(!layers.length){ deterministicCanvas=null; photoImage.src=baseImageSrc; return; }
  setBusy(true,'Placing exact tile with software renderer…');
  try{
    deterministicCanvas=await LocalTileEngine.composite(baseImg,layers);
    photoImage.src=deterministicCanvas.toDataURL('image/png');
    currentDisplaySrc=photoImage.src;
    const touch=document.getElementById('aiTouchupBtn'); if(touch) touch.disabled=false;
  }catch(err){showError(err.message||'Tile rendering failed.');}
  finally{setBusy(false);}
}

/* Use the AI edit only to estimate a lighting field. The selected tile,
   grout and perspective remain the deterministic pixels underneath. */
async function aiTouchup(){
  if(!deterministicCanvas || busy) return;
  clearError(); setBusy(true,'AI is preparing a lighting/shadow reference…');
  try{
    const res=await fetch('/api/ai-touchup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseImage:deterministicCanvas.toDataURL('image/png'),provider:selectedAIProvider})});
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||`Server returned ${res.status}`);
    const aiImg=await loadImage(`data:image/png;base64,${data.imageBase64}`);
    const touched=applyLightingReference(deterministicCanvas,aiImg);
    deterministicCanvas=touched;
    photoImage.src=touched.toDataURL('image/png');
    currentDisplaySrc=photoImage.src;
  }catch(err){showError(err.message||'AI touch-up failed. The accurate software render is still available.');}
  finally{setBusy(false);}
}

function pointInPoly(px,py,poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];
    if(((yi>py)!==(yj>py)) && px < (xj-xi)*(py-yi)/((yj-yi)||1e-12)+xi) inside=!inside;
  }
  return inside;
}
function applyLightingReference(base,aiImg){
  const w=base.width,h=base.height;
  const out=document.createElement('canvas');out.width=w;out.height=h;
  const o=out.getContext('2d');o.drawImage(base,0,0);
  const bd=o.getImageData(0,0,w,h), ref=document.createElement('canvas');ref.width=w;ref.height=h;const rc=ref.getContext('2d');rc.drawImage(aiImg,0,0,w,h);const rd=rc.getImageData(0,0,w,h).data;
  const surfaces=[analysis?.floor,analysis?.wall].filter(Boolean).map(toPxSurface);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    if(!surfaces.some(s=>pointInPoly(x+0.5,y+0.5,s.polygon))) continue;
    const i=(y*w+x)*4;
    const br=bd.data[i],bg=bd.data[i+1],bb=bd.data[i+2];
    const baseLum=0.299*br+0.587*bg+0.114*bb;
    const rr=rd[i],rg=rd[i+1],rb=rd[i+2];
    const refLum=0.299*rr+0.587*rg+0.114*rb;
    let factor=refLum/Math.max(18,baseLum);
    factor=Math.max(0.78,Math.min(1.22,factor));
    // Keep touch-up subtle; 0.35 strength means the AI reference cannot
    // overpower the exact catalog tile underneath it.
    factor=1+(factor-1)*0.35;
    bd.data[i]=Math.max(0,Math.min(255,br*factor));
    bd.data[i+1]=Math.max(0,Math.min(255,bg*factor));
    bd.data[i+2]=Math.max(0,Math.min(255,bb*factor));
  }
  o.putImageData(bd,0,0);return out;
}

function downloadResult(){
  if(!deterministicCanvas){showError('Choose a tile first.');return;}
  const a=document.createElement('a');a.href=deterministicCanvas.toDataURL('image/png');a.download='tile-studio-ai-result.png';document.body.appendChild(a);a.click();a.remove();
}

renderPickerSidebar();
