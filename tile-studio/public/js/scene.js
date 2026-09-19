/* ============================================================
   scene.js — three.js r128 scene, room, furniture, camera
   ============================================================ */

const holder = document.getElementById('canvas-holder');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xDAD4C6);
scene.fog = new THREE.Fog(0xDAD4C6, 8, 17);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
holder.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff,0.28));
const hemi = new THREE.HemisphereLight(0xE8E2D5,0x3A332B,0.35);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xFFF4E0,1.15);
dir.position.set(3,5,4);
dir.castShadow = true;
dir.shadow.mapSize.set(2048,2048);
dir.shadow.camera.left = -4; dir.shadow.camera.right = 4;
dir.shadow.camera.top = 4; dir.shadow.camera.bottom = -4;
dir.shadow.camera.near = 0.5; dir.shadow.camera.far = 14;
dir.shadow.bias = -0.0015;
dir.shadow.radius = 4;
scene.add(dir);
const fill = new THREE.DirectionalLight(0xC9D3DA, 0.32);
fill.position.set(-4,3,-2);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xFFFFFF, 0.22);
rim.position.set(-2,4,5);
scene.add(rim);

/* ---------- environment reflections ----------
   Tries a real photographed interior HDRI (converted from an EXR
   panorama, tonemapped to an 8-bit equirectangular JPG) first, since
   real reflections read far more convincingly than a gradient. Falls
   back to the procedural gradient sky, silently, if the file is
   missing — same "drop it in, get a better result" pattern as the
   GLB furniture hook. */
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();

function applyGradientEnv(){
  const envCanvas = document.createElement('canvas');
  envCanvas.width = 2; envCanvas.height = 256;
  const envCtx = envCanvas.getContext('2d');
  const envGrad = envCtx.createLinearGradient(0,0,0,256);
  envGrad.addColorStop(0,'#F4F1EA');
  envGrad.addColorStop(0.5,'#C9C2B4');
  envGrad.addColorStop(1,'#6E685D');
  envCtx.fillStyle = envGrad; envCtx.fillRect(0,0,2,256);
  const envTex = new THREE.CanvasTexture(envCanvas);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  envTex.encoding = THREE.sRGBEncoding;
  scene.environment = pmrem.fromEquirectangular(envTex).texture;
}

const envLoader = new THREE.TextureLoader();
envLoader.load(
  'assets/env/small-empty-room.jpg',
  (tex)=>{
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.encoding = THREE.sRGBEncoding;
    scene.environment = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
  },
  undefined,
  ()=>{ applyGradientEnv(); }
);
applyGradientEnv(); // immediate placeholder while the real HDRI loads

/* ---------- room shell ---------- */
const roomGroup = new THREE.Group();
scene.add(roomGroup);

/* ---------- texture cache (color + Sobel normal + roughness) ---------- */
/* Keyed by `${id}@${density}` so re-tiling at a new slider value
   regenerates and caches independently of the default density. */
const texCache = { floor:{}, wall:{} };
const photoTexLoader = new THREE.TextureLoader();

function getTileTextures(kind, id, density){
  const list = kind==='floor' ? [...FLOOR_TILES,...CUSTOM_FLOOR_TILES] : [...WALL_TILES,...CUSTOM_WALL_TILES];
  const def = list.find(t=>t.id===id);
  // photo tiles ignore the re-tile density slider (fixed real-world scale),
  // so they share one cache entry regardless of the slider position
  const key = def.photo ? id+'@photo' : id+'@'+density.toFixed(2);
  const cache = texCache[kind];
  if(cache[key]) return cache[key];
  const repeat = kind==='floor' ? [4,4] : [3,2];

  if(def.photo){
    // real photographed PBR set (diffuse/normal/roughness maps shot for
    // this material) instead of a procedural canvas + derived normal map.
    // Density/re-tile slider doesn't apply — these tile at their native scale.
    const load = (file, srgb)=>{
      const tex = photoTexLoader.load(def.photo.base + file);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repeat[0], repeat[1]);
      if(srgb) tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      return tex;
    };
    const map = load(def.photo.diffuse, true);
    const normalMap = load(def.photo.normal, false);
    const roughnessMap = load(def.photo.roughness, false);
    const bundle = { map, normalMap, roughnessMap, def };
    cache[key] = bundle;
    return bundle;
  }

  const c = makeCanvas(def.textureCanvas ? def.textureCanvas.width : 768);
  if(def.textureCanvas){
    // AI-generated custom tile: already-painted canvas/image, just draw it in
    c.getContext('2d').drawImage(def.textureCanvas,0,0,c.width,c.height);
  } else {
    def.paint(c.getContext('2d'), c.width, density);
  }
  const map = new THREE.CanvasTexture(c);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(repeat[0],repeat[1]);
  map.encoding = THREE.sRGBEncoding;
  map.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const normalMap = makeNormalTexture(c, repeat[0], repeat[1], def.glossy ? 1.1 : 1.9);
  const roughnessMap = makeRoughnessTexture(c, repeat[0], repeat[1], def.glossy);
  const bundle = { map, normalMap, roughnessMap, def };
  cache[key] = bundle;
  return bundle;
}

const floorMat = new THREE.MeshStandardMaterial({ roughness:0.82, metalness:0.02, side:THREE.DoubleSide, envMapIntensity:0.4 });
const wallMat = new THREE.MeshStandardMaterial({ roughness:0.92, metalness:0.0, side:THREE.DoubleSide, envMapIntensity:0.15 });

const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(6,6), floorMat);
floorMesh.rotation.x = -Math.PI/2;
floorMesh.receiveShadow = true;
roomGroup.add(floorMesh);

const wallBack = new THREE.Mesh(new THREE.PlaneGeometry(6,3), wallMat);
wallBack.position.set(0,1.5,-3);
wallBack.receiveShadow = true;
roomGroup.add(wallBack);

const wallLeft = new THREE.Mesh(new THREE.PlaneGeometry(6,3), wallMat);
wallLeft.rotation.y = Math.PI/2;
wallLeft.position.set(-3,1.5,0);
wallLeft.receiveShadow = true;
roomGroup.add(wallLeft);

const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(6,6), new THREE.MeshStandardMaterial({ color:0xF2EEE5, roughness:1, side:THREE.DoubleSide }));
ceiling.rotation.x = Math.PI/2;
ceiling.position.y = 3;
ceiling.receiveShadow = true;
roomGroup.add(ceiling);

const skirtMat = new THREE.MeshStandardMaterial({ color:0xF2EEE5, roughness:0.5 });
const skirtBack = new THREE.Mesh(new THREE.BoxGeometry(6,0.09,0.03), skirtMat);
skirtBack.position.set(0,0.045,-2.985);
skirtBack.receiveShadow = true;
roomGroup.add(skirtBack);
const skirtLeft = new THREE.Mesh(new THREE.BoxGeometry(6,0.09,0.03), skirtMat);
skirtLeft.rotation.y = Math.PI/2;
skirtLeft.position.set(-2.985,0.045,0);
skirtLeft.receiveShadow = true;
roomGroup.add(skirtLeft);

/* window set into the back wall, for a believable daylight source */
const windowFrame = new THREE.Mesh(new THREE.BoxGeometry(1.5,1.7,0.06), new THREE.MeshStandardMaterial({ color:0xEDE8DF, roughness:0.6 }));
windowFrame.position.set(1.6,1.85,-2.97);
windowFrame.castShadow = true;
roomGroup.add(windowFrame);
function makeWindowView(){
  const c = makeCanvas(256);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0,0,0,256);
  g.addColorStop(0,'#C3D6E0');
  g.addColorStop(0.55,'#DCE6D9');
  g.addColorStop(1,'#8FA87B');
  ctx.fillStyle = g; ctx.fillRect(0,0,256,256);
  ctx.filter = 'blur(11px)';
  for(let i=0;i<6;i++){
    ctx.fillStyle = `rgba(${(90+Math.random()*40)|0},${(120+Math.random()*40)|0},${(70+Math.random()*30)|0},0.55)`;
    ctx.beginPath();
    ctx.ellipse(40+Math.random()*180,150+Math.random()*70,40+Math.random()*30,30+Math.random()*20,0,0,Math.PI*2);
    ctx.fill();
  }
  ctx.filter = 'none';
  return new THREE.CanvasTexture(c);
}
const windowViewTex = makeWindowView();
const windowPane = new THREE.Mesh(new THREE.PlaneGeometry(1.32,1.5), new THREE.MeshStandardMaterial({ map:windowViewTex, emissiveMap:windowViewTex, emissive:0xFFFFFF, emissiveIntensity:0.2, roughness:0.25 }));
windowPane.position.set(1.6,1.85,-2.93);
roomGroup.add(windowPane);
const muntinV = new THREE.Mesh(new THREE.BoxGeometry(0.03,1.5,0.03), skirtMat);
muntinV.position.set(1.6,1.85,-2.92);
roomGroup.add(muntinV);
const muntinH = new THREE.Mesh(new THREE.BoxGeometry(1.32,0.03,0.03), skirtMat);
muntinH.position.set(1.6,1.85,-2.92);
roomGroup.add(muntinH);

/* ---------- tile application (incl. re-tile density) ---------- */
let currentFloor = 'marble', currentWall = 'subway';
let floorDensity = 1, wallDensity = 1;

function applyFloor(id, density){
  currentFloor = id;
  if(density!==undefined) floorDensity = density;
  const { map, normalMap, roughnessMap, def } = getTileTextures('floor', id, floorDensity);
  floorMat.map = map;
  floorMat.normalMap = normalMap;
  floorMat.normalScale.set(1,1);
  floorMat.roughnessMap = roughnessMap;
  floorMat.roughness = def.roughness;
  floorMat.needsUpdate = true;
  document.getElementById('floorLabel').textContent = def.name;
}
function applyWall(id, density){
  currentWall = id;
  if(density!==undefined) wallDensity = density;
  const { map, normalMap, roughnessMap, def } = getTileTextures('wall', id, wallDensity);
  wallMat.map = map;
  wallMat.normalMap = normalMap;
  wallMat.normalScale.set(1,1);
  wallMat.roughnessMap = roughnessMap;
  wallMat.roughness = def.roughness;
  wallMat.needsUpdate = true;
  document.getElementById('wallLabel').textContent = def.name;
}

/* ---------- furniture: procedural boxes by default, silently
   swapped for a real GLB model if one has been dropped in
   public/assets/models/ — no code changes needed to use it. ---------- */
const furnitureGroup = new THREE.Group();
roomGroup.add(furnitureGroup);
const gltfLoader = (typeof THREE.GLTFLoader === 'function') ? new THREE.GLTFLoader() : null;

function clearFurniture(){
  while(furnitureGroup.children.length){
    const m = furnitureGroup.children.pop();
    m.traverse && m.traverse(n=>{ n.geometry && n.geometry.dispose && n.geometry.dispose(); });
    m.geometry && m.geometry.dispose();
    m.material && m.material.dispose && m.material.dispose();
  }
}
function addBox(w,h,d,color,x,y,z,ry){
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), new THREE.MeshStandardMaterial({color,roughness:0.7,envMapIntensity:0.25}));
  mesh.position.set(x,y,z);
  if(ry) mesh.rotation.y = ry;
  mesh.castShadow = true; mesh.receiveShadow = true;
  furnitureGroup.add(mesh);
  return mesh;
}
function addCylinder(rt,rb,h,color,x,y,z){
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,24), new THREE.MeshStandardMaterial({color,roughness:0.6,envMapIntensity:0.25}));
  mesh.position.set(x,y,z);
  mesh.castShadow = true; mesh.receiveShadow = true;
  furnitureGroup.add(mesh);
  return mesh;
}
/* real photographed PBR texture sets for the furniture models, keyed by
   the same name used for the .glb file — the .glb geometry itself ships
   with no baked-in textures (a quirk of the Blender->glTF export used to
   make them), so these are applied on top after load, mapped onto the
   mesh's own UVs (no tiling/repeat — these are per-object UV atlases). */
const FURNITURE_TEXTURES = {
  'dining-chair': { base:'assets/furniture-textures/dining-chair/', diffuse:'diffuse.jpg', normal:'normal.png', roughness:'roughness.png', metalness:'metalness.png' },
  'coffee-table': { base:'assets/furniture-textures/coffee-table/', diffuse:'diffuse.jpg', normal:'normal.png', roughness:'roughness.png' },
  'side-table':   { base:'assets/furniture-textures/side-table/', diffuse:'diffuse.jpg', normal:'normal.png', roughness:'roughness.png', metalness:'metalness.png' },
  'day-bed':      { base:'assets/furniture-textures/day-bed/', diffuse:'diffuse.jpg', normal:'normal.png', roughness:'roughness.png', metalness:'metalness.png' },
};
const furnitureTexLoader = new THREE.TextureLoader();
function applyFurnitureTextures(model, name){
  const set = FURNITURE_TEXTURES[name];
  if(!set) return;
  const load = (file, srgb)=>{
    const tex = furnitureTexLoader.load(set.base + file);
    if(srgb) tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex; // default ClampToEdge wrap — this is a per-object UV atlas, not a tiling material
  };
  const map = set.diffuse ? load(set.diffuse, true) : null;
  const normalMap = set.normal ? load(set.normal, false) : null;
  const roughnessMap = set.roughness ? load(set.roughness, false) : null;
  const metalnessMap = set.metalness ? load(set.metalness, false) : null;
  model.traverse(n=>{
    if(!n.isMesh) return;
    const mat = new THREE.MeshStandardMaterial({
      map, normalMap, roughnessMap, metalnessMap,
      metalness: metalnessMap ? 1 : 0,
      roughness: 1,
      envMapIntensity: 0.35,
    });
    n.material = mat;
  });
}

/* Tries public/assets/models/<name>.glb first; falls back to
   `buildProcedural()` (sync) if the file is missing or fails to
   parse. Silent by design — this is a "drop a file in, get a
   better model" hook, not something the user has to wire up.

   These asset-pack models are exported Z-up (Blender's native axis),
   not the Y-up glTF convention three.js expects, so each load gets a
   -90° X correction before any caller-supplied Y rotation. */
function addModelOrProcedural(name, x, y, z, ry, scale, buildProcedural){
  const path = `assets/models/${name}.glb`;
  if(!gltfLoader){ buildProcedural(); return; }
  gltfLoader.load(path, (gltf)=>{
    const model = gltf.scene;
    const rig = new THREE.Group();
    rig.add(model);
    model.rotation.x = -Math.PI/2; // Z-up source -> Y-up scene
    rig.position.set(x,y,z);
    if(ry) rig.rotation.y = ry;
    if(scale) rig.scale.setScalar(scale);
    model.traverse(n=>{ if(n.isMesh){ n.castShadow = true; n.receiveShadow = true; } });
    applyFurnitureTextures(model, name);
    furnitureGroup.add(rig);
  }, undefined, ()=>{ buildProcedural(); });
}

function buildLivingRoom(){
  clearFurniture();
  /* vintage day-bed stands in for the sofa — real scanned model,
     ~1.97 x 0.85 x 1.13m, close enough to the old sofa box to sit
     in the same spot against the back-left wall. */
  addModelOrProcedural('day-bed', -1.1, 0, -1.3, Math.PI/2, 1, ()=>{
    addBox(2.1,0.55,0.85,0x4A5A52,-1.1,0.275,-1.3);
    addBox(2.1,0.5,0.15,0x3E4C46,-1.1,0.55,-1.68);
  });
  addModelOrProcedural('coffee-table', 0.6, 0, -0.6, 0, 1, ()=>{
    addCylinder(0.42,0.42,0.32,0x7C542B,0.6,0.16,-0.6);
  });
  addCylinder(0.05,0.05,1.3,0x2B2A28,1.9,0.65,-2.6);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.28,0.4,16,1,true), new THREE.MeshStandardMaterial({color:0xEDE8DF,roughness:0.9,side:THREE.DoubleSide}));
  shade.position.set(1.9,1.4,-2.6);
  shade.castShadow = true;
  furnitureGroup.add(shade);
  addModelOrProcedural('side-table', 2.3, 0, -0.2, 0, 1, ()=>{
    addCylinder(0.16,0.19,0.35,0x8B4A29,2.3,0.175,-0.2);
  });
  const foliage = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4,0), new THREE.MeshStandardMaterial({color:0x4F6B4A,roughness:0.85}));
  foliage.position.set(2.3,0.75,-0.2);
  foliage.castShadow = true; foliage.receiveShadow = true;
  furnitureGroup.add(foliage);
  addCylinder(0.08,0.08,0.55,0x6E685D,0.6,0.575,-0.6);
  /* accent chair — real scanned model, has no procedural fallback
     shape since it's a pure bonus piece, so pass a no-op. */
  addModelOrProcedural('dining-chair', -2.35, 0, 1.5, Math.PI*0.2, 1, ()=>{});
}
function buildBathroom(){
  clearFurniture();
  addBox(1.6,0.75,0.55,0xEDE8DF,-1.6,0.375,-2.6);
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.24,0.2,0.15,24), new THREE.MeshStandardMaterial({color:0xF4F1EA,roughness:0.35}));
  basin.position.set(-1.6,0.82,-2.6);
  basin.castShadow = true; basin.receiveShadow = true;
  furnitureGroup.add(basin);
  const mirror = new THREE.Mesh(new THREE.PlaneGeometry(0.7,0.9), new THREE.MeshStandardMaterial({color:0xB9C3C7,roughness:0.08,metalness:0.4,envMapIntensity:1}));
  mirror.position.set(-1.6,1.75,-2.97);
  furnitureGroup.add(mirror);
  addBox(0.74,0.94,0.04,0x2B2A28,-1.6,1.75,-2.985);
  addCylinder(0.22,0.24,0.42,0xF4F1EA,1.6,0.21,-2.5);
  addBox(0.3,0.32,0.32,0xC9C2B4,1.6,0.16,-2.5);
  addCylinder(0.18,0.18,0.4,0xEDE8DF,1.9,0.2,-0.4);
  /* real scanned chair, doubles as a bathroom stool here */
  addModelOrProcedural('dining-chair', 0.5, 0, -1.55, Math.PI, 0.9, ()=>{});
}

/* ---------- camera orbit controls (manual, r128 has no OrbitControls) ---------- */
const target = new THREE.Vector3(0,1,0);
let azimuth = 0.62, polar = 1.12, radius = 7.2;
let dragging = false, lastX = 0, lastY = 0;
let idleTimer = null, autoRotate = true;

function updateCamera(){
  camera.position.x = target.x + radius*Math.sin(polar)*Math.sin(azimuth);
  camera.position.y = target.y + radius*Math.cos(polar);
  camera.position.z = target.z + radius*Math.sin(polar)*Math.cos(azimuth);
  camera.lookAt(target);
}
function onDown(e){
  dragging = true; autoRotate = false;
  lastX = e.clientX; lastY = e.clientY;
  clearTimeout(idleTimer);
}
function onMove(e){
  if(!dragging) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  azimuth -= dx*0.006;
  polar = clamp(polar - dy*0.006, 0.5, 1.5);
}
function onUp(){
  dragging = false;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(()=>{ autoRotate = true; }, 2200);
}
renderer.domElement.addEventListener('pointerdown', onDown);
window.addEventListener('pointermove', onMove);
window.addEventListener('pointerup', onUp);
renderer.domElement.addEventListener('wheel', (e)=>{
  e.preventDefault();
  radius = clamp(radius + e.deltaY*0.0035, 3.5, 11);
}, { passive:false });

/* ---------- resize ---------- */
function resize(){
  const w = holder.clientWidth, h = holder.clientHeight;
  camera.aspect = w/h;
  camera.updateProjectionMatrix();
  renderer.setSize(w,h);
}
window.addEventListener('resize', resize);

function animate(){
  requestAnimationFrame(animate);
  if(autoRotate && !dragging) azimuth += 0.0016;
  updateCamera();
  renderer.render(scene, camera);
}
