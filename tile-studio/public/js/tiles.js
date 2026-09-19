/* ============================================================
   tiles.js — shared catalog
   Used by both the 3D renderer (paint fn + roughness/glossy) and
   the AI panel (desc string dropped straight into the image prompt).
   Keeping one source of truth means the swatch you see in 3D and
   the material named in an AI render always match.
   ============================================================ */

const FLOOR_TILES = [
  { id:'marble', name:'Calacatta Marble', roughness:0.32, glossy:true,
    desc:'polished Calacatta marble floor tile, white stone with soft grey veining, glossy reflective finish',
    paint:(ctx,sz,density)=>drawMarble(ctx,sz,'#EDEAE2','#B7AE9E',density) },
  { id:'granite', name:'Charcoal Granite', roughness:0.28, glossy:true,
    desc:'polished charcoal granite floor tile, dark speckled stone, glossy reflective finish',
    paint:(ctx,sz,density)=>drawGranite(ctx,sz,'#2B2A28',['#3D3B38','#1C1B19','#55524D','#0F0E0D'],density) },
  { id:'oak', name:'Warm Oak Wood', roughness:0.7, glossy:false,
    desc:'warm oak wood-look floor planks, honey brown with visible grain, matte satin finish',
    paint:(ctx,sz,density)=>drawWoodPlank(ctx,sz,'#A9763F','#7C542B',density) },
  { id:'terracotta', name:'Terracotta Clay', roughness:0.8, glossy:false,
    desc:'terracotta clay floor tile, warm burnt-orange squares with visible grout lines, matte unglazed finish',
    paint:(ctx,sz,density)=>drawGroutGrid(ctx,sz,'#B5643A','#8B4A29',6,6,0.12,{},density) },
  { id:'herringbone', name:'Ash Herringbone', roughness:0.66, glossy:false,
    desc:'ash grey herringbone parquet floor tile, matte finish, classic zigzag pattern',
    paint:(ctx,sz,density)=>drawHerringbone(ctx,sz,'#8B8478','#6E685D',density) },
  { id:'concrete', name:'Polished Concrete', roughness:0.76, glossy:false,
    desc:'polished concrete floor, light warm grey, subtle fine speckle, satin matte finish',
    paint:(ctx,sz,density)=>drawNoiseFlat(ctx,sz,'#9B978D','#716D64',density) },
  /* real photographed PBR sets (diffuse + normal + roughness maps shot
     for the material, not procedurally painted) — see photo.base */
  { id:'photo-oak', name:'Aged Oak Plank', roughness:1, glossy:false,
    desc:'aged reclaimed oak wood plank flooring, weathered honey-brown with dark grain and subtle wear marks, satin finish',
    photo:{ base:'assets/textures/old-wooden-floor/', diffuse:'diffuse.jpg', normal:'normal.png', roughness:'roughness.png' } },
  { id:'photo-terrazzo', name:'Umber Terrazzo', roughness:1, glossy:false,
    desc:'umber brown speckled terrazzo floor tile with fine stone aggregate and faint grid seams, satin finish',
    photo:{ base:'assets/textures/terrazzo-tiles/', diffuse:'diffuse.jpg', normal:'normal.png', roughness:'roughness.png' } },
  { id:'photo-diamond', name:'Diamond Ceramic', roughness:1, glossy:false,
    desc:'diagonally-laid diamond ceramic floor tile, warm taupe with dark grout lines, matte finish',
    photo:{ base:'assets/textures/interior-tiles/', diffuse:'diffuse.jpg', normal:'normal.png', roughness:'roughness.png' } },
];

const WALL_TILES = [
  { id:'subway', name:'Ivory Subway', roughness:0.22, glossy:true,
    desc:'ivory white subway tile, classic brick-offset pattern, glossy ceramic finish with visible grout lines',
    paint:(ctx,sz,density)=>drawGroutGrid(ctx,sz,'#EDE8DF','#C9C2B4',8,16,0.05,{offsetRows:true},density) },
  { id:'sage', name:'Sage Mosaic', roughness:0.28, glossy:true,
    desc:'sage green square mosaic wall tile, glossy ceramic finish, small grid pattern with grout lines',
    paint:(ctx,sz,density)=>drawGroutGrid(ctx,sz,'#7C8B77','#5B6857',16,16,0.1,{},density) },
  { id:'slate', name:'Dark Slate Stone', roughness:0.62, glossy:false,
    desc:'dark slate stone wall cladding, charcoal grey natural stone texture, matte honed finish',
    paint:(ctx,sz,density)=>drawGranite(ctx,sz,'#3A3D3E',['#4A4E50','#2C2E2F','#565A5C'],density) },
  { id:'terrazzo', name:'Terrazzo Fleck', roughness:0.3, glossy:true,
    desc:'terrazzo wall tile, cream base with rust orange sage green and black stone flecks, glossy polished finish',
    paint:(ctx,sz,density)=>drawTerrazzo(ctx,sz,'#E4DFD3',['#C97B5C','#4A5A52','#2B2A28','#B9B2A6'],density) },
  { id:'sandstone', name:'Sandstone Beige', roughness:0.8, glossy:false,
    desc:'sandstone beige wall tile, warm tan natural stone texture, matte finish',
    paint:(ctx,sz,density)=>drawNoiseFlat(ctx,sz,'#C9B896','#A8946C',density) },
  { id:'navy', name:'Navy Ceramic', roughness:0.18, glossy:true,
    desc:'deep navy blue ceramic wall tile, glossy high-shine finish, grid pattern with thin grout lines',
    paint:(ctx,sz,density)=>drawGroutGrid(ctx,sz,'#2E3A4A','#1C2530',10,10,0.04,{},density) },
];

/* Custom AI-generated tiles get pushed into these at runtime so they
   appear in the swatch grid and are selectable/orbitable like any
   catalog tile. Kept separate from the static arrays above so a
   fresh page load always starts from the known-good catalog. */
const CUSTOM_FLOOR_TILES = [];
const CUSTOM_WALL_TILES = [];
