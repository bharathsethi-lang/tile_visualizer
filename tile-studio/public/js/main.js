/* ============================================================
   main.js — UI wiring, glues tiles.js catalog to scene.js
   ============================================================ */

function buildSwatchGrid(container, tiles, onSelect, selectedId){
  container.innerHTML = '';
  tiles.forEach(t=>{
    const btn = document.createElement('button');
    btn.className = 'swatch' + (t.id===selectedId ? ' selected' : '');
    btn.dataset.id = t.id;
    const c = document.createElement('canvas');
    c.width = 96; c.height = 96;
    if(t.textureCanvas){ c.getContext('2d').drawImage(t.textureCanvas,0,0,96,96); }
    else if(t.photo){
      // real photo swatch: draw a neutral placeholder immediately, then
      // the actual diffuse thumbnail once it loads (async, unlike the
      // synchronous canvas painters)
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#3A372F'; ctx.fillRect(0,0,96,96);
      const img = new Image();
      img.onload = ()=>{ ctx.drawImage(img,0,0,96,96); };
      img.src = t.photo.base + t.photo.diffuse;
    }
    else { t.paint(c.getContext('2d'), 96, 1); }
    const label = document.createElement('div');
    label.className = 'swatch-name';
    label.textContent = t.name;
    btn.appendChild(c);
    btn.appendChild(label);
    btn.addEventListener('click', ()=>{
      container.querySelectorAll('.swatch').forEach(s=>s.classList.remove('selected'));
      btn.classList.add('selected');
      onSelect(t.id);
    });
    container.appendChild(btn);
  });
}

function refreshFloorGrid(){ buildSwatchGrid(document.getElementById('floorGrid'), [...FLOOR_TILES,...CUSTOM_FLOOR_TILES], (id)=>applyFloor(id), currentFloor); }
function refreshWallGrid(){ buildSwatchGrid(document.getElementById('wallGrid'), [...WALL_TILES,...CUSTOM_WALL_TILES], (id)=>applyWall(id), currentWall); }

refreshFloorGrid();
refreshWallGrid();

document.getElementById('roomTabs').addEventListener('click', (e)=>{
  const btn = e.target.closest('.room-tab');
  if(!btn) return;
  document.querySelectorAll('.room-tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  btn.dataset.room === 'bathroom' ? buildBathroom() : buildLivingRoom();
});

/* ---------- tile-scale sliders (re-tile, not UV-stretch) ---------- */
const floorScale = document.getElementById('floorScale');
const wallScale = document.getElementById('wallScale');
let floorScaleTimer = null, wallScaleTimer = null;
floorScale.addEventListener('input', ()=>{
  clearTimeout(floorScaleTimer);
  floorScaleTimer = setTimeout(()=>{ applyFloor(currentFloor, parseFloat(floorScale.value)); }, 90);
});
wallScale.addEventListener('input', ()=>{
  clearTimeout(wallScaleTimer);
  wallScaleTimer = setTimeout(()=>{ applyWall(currentWall, parseFloat(wallScale.value)); }, 90);
});

/* ---------- init ---------- */
applyFloor(currentFloor);
applyWall(currentWall);
buildLivingRoom();
resize();
updateCamera();
animate();
