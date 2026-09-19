/* ============================================================
   ai.js — sidebar AI add-ons. Both features are explicit-click
   only (never fired automatically) since they cost an API call.
   ============================================================ */

const API_BASE = ''; // same-origin; server serves /public and /api/*

/* Every AI Studio call goes through this so a dead/missing backend fails
   visibly instead of spinning forever — e.g. if this page was opened via
   `npx serve` (static-only, no /api/* routes) instead of the Express
   server (`npm start` in tile-studio/server). */
async function fetchWithTimeout(url, options, timeoutMs){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try{
    return await fetch(url, { ...options, signal: controller.signal });
  } catch(err){
    if(err.name === 'AbortError'){
      throw new Error(`No response after ${Math.round(timeoutMs/1000)}s — is the Express server running (\`npm start\` in tile-studio/server), not just \`npx serve\`?`);
    }
    throw new Error('Could not reach the server. Is it running?');
  } finally {
    clearTimeout(timer);
  }
}

/* Parses a fetch Response as JSON, but first checks the content-type —
   a static file server (or any server with no matching /api/* route)
   typically answers a POST to /api/* with its index.html fallback or a
   plain-text 404, which res.json() would otherwise choke on with a
   confusing "Unexpected token '<'" parser error. */
async function parseJsonResponse(res){
  const contentType = res.headers.get('content-type') || '';
  if(!contentType.includes('application/json')){
    const preview = (await res.text()).slice(0,40).replace(/\s+/g,' ').trim();
    throw new Error(
      `Server didn't return JSON (got "${preview}${preview.length===40?'…':''}"). ` +
      `Is the Express server running (\`npm start\` in tile-studio/server) — not just \`npx serve\`?`
    );
  }
  return res.json();
}

/* ---------- custom tile generation ---------- */
const generateTileBtn = document.getElementById('generateTileBtn');
const customTilePrompt = document.getElementById('customTilePrompt');
const customTileTarget = document.getElementById('customTileTarget');
const customTileError = document.getElementById('customTileError');

generateTileBtn.addEventListener('click', async ()=>{
  const prompt = customTilePrompt.value.trim();
  const target = customTileTarget.value; // 'floor' | 'wall'
  customTileError.hidden = true;
  if(!prompt){
    customTileError.textContent = 'Describe the tile first — material, color, and finish work best.';
    customTileError.hidden = false;
    return;
  }
  generateTileBtn.disabled = true;
  const originalLabel = generateTileBtn.textContent;
  generateTileBtn.textContent = 'Generating…';
  try{
    const res = await fetchWithTimeout(`${API_BASE}/api/generate-tile`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ prompt, target })
    }, 30000);
    const data = await parseJsonResponse(res);
    if(!res.ok) throw new Error(data.error || `Server returned ${res.status}`);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject)=>{
      img.onload = resolve;
      img.onerror = ()=>reject(new Error('Generated image failed to decode.'));
      img.src = `data:image/png;base64,${data.imageBase64}`;
    });
    const canvas = makeCanvas(768);
    canvas.getContext('2d').drawImage(img, 0, 0, 768, 768);

    const id = `custom-${target}-${Date.now()}`;
    const entry = {
      id,
      name: prompt.length > 26 ? prompt.slice(0,24)+'…' : prompt,
      roughness: 0.5,
      glossy: /glossy|polish|shine|reflect|ceramic|marble|glaze/i.test(prompt),
      desc: prompt,
      textureCanvas: canvas
    };
    if(target === 'floor'){ CUSTOM_FLOOR_TILES.push(entry); refreshFloorGrid(); applyFloor(id); }
    else { CUSTOM_WALL_TILES.push(entry); refreshWallGrid(); applyWall(id); }

    customTilePrompt.value = '';
  } catch(err){
    customTileError.textContent = err.message || 'Something went wrong generating that tile. Try again.';
    customTileError.hidden = false;
  } finally {
    generateTileBtn.disabled = false;
    generateTileBtn.textContent = originalLabel;
  }
});

/* ---------- photoreal render ---------- */
const photorealBtn = document.getElementById('photorealBtn');
const photorealError = document.getElementById('photorealError');
const modal = document.getElementById('photorealModal');
const modalClose = document.getElementById('photorealClose');
const modalLoading = document.getElementById('photorealLoading');
const modalLoadingText = document.getElementById('photorealLoadingText');
const modalErrorBanner = document.getElementById('photorealErrorBanner');
const modalImage = document.getElementById('photorealImage');

const loadingMessages = [
  'Generating render…',
  'Compositing your tile choice…',
  'Still going — edits can take up to a minute…'
];

function openModal(){ modal.hidden = false; }
function closeModal(){ modal.hidden = true; }
modalClose.addEventListener('click', closeModal);
modal.addEventListener('click', (e)=>{ if(e.target === modal) closeModal(); });

photorealBtn.addEventListener('click', async ()=>{
  photorealError.hidden = true;
  openModal();
  modalErrorBanner.hidden = true;
  modalLoading.hidden = false;
  // keep the last good render visible under the spinner isn't possible with
  // hidden image, so just hide it while loading; the last successful src
  // stays cached on the <img> element if generation fails below.
  modalImage.hidden = true; // (CSS also enforces this — see .modal-body img[hidden])

  let msgIdx = 0;
  modalLoadingText.textContent = loadingMessages[0];
  const msgTimer = setInterval(()=>{
    msgIdx = Math.min(msgIdx+1, loadingMessages.length-1);
    modalLoadingText.textContent = loadingMessages[msgIdx];
  }, 6000);

  const activeRoom = document.querySelector('.room-tab.active').dataset.room;
  const floorDef = [...FLOOR_TILES,...CUSTOM_FLOOR_TILES].find(t=>t.id===currentFloor);
  const wallDef = [...WALL_TILES,...CUSTOM_WALL_TILES].find(t=>t.id===currentWall);

  try{
    const res = await fetchWithTimeout(`${API_BASE}/api/generate-tile-render`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        room: activeRoom,
        floorTileId: currentFloor,
        wallTileId: currentWall,
        floorDesc: floorDef ? floorDef.desc : '',
        wallDesc: wallDef ? wallDef.desc : ''
      })
    }, 90000);
    const data = await parseJsonResponse(res);
    if(!res.ok) throw new Error(data.error || `Server returned ${res.status}`);

    modalImage.src = `data:image/png;base64,${data.imageBase64}`;
    modalImage.hidden = false;
  } catch(err){
    const message = err.message || 'The render failed. Try again in a moment.';
    modalErrorBanner.textContent = message;
    modalErrorBanner.hidden = false;
    photorealError.textContent = message;
    photorealError.hidden = false;
    // if a previous render exists, restore it under the error banner so
    // one failed attempt doesn't erase the last good image
    if(modalImage.getAttribute('src')) modalImage.hidden = false;
  } finally {
    clearInterval(msgTimer);
    modalLoading.hidden = true;
  }
});
