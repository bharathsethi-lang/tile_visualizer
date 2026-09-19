/* ============================================================
   room-geometry.js — Non-AI Mode only.
   Floor/wall quadrilaterals (in original-image pixel coordinates,
   corners ordered top-left, top-right, bottom-right, bottom-left)
   for each predefined preset photo, so predefined rooms don't need
   the four-point tool — same idea as the server/masks/*.png masks
   used by studio.html's AI panel, just expressed as polygons instead
   of painted PNGs since these presets are flat placeholder graphics
   (see README) rather than real photographed rooms.

   The project ships no server/masks/*.png or corner-coordinate JSON
   for these three presets, so these quads were measured directly off
   the actual placeholder images (all three share one 1024x1024
   layout: a flat "wall" band, a flat "floor" band, a divider line,
   and a label strip at the bottom).

   Drop in real photos (see README's "About the preset photos") and
   these corners should be updated to trace the real floor/wall
   outlines — use the four-point tool on an uploaded copy of the new
   photo to find good values, then hardcode them here.
   ============================================================ */

const ROOM_GEOMETRY = {
  'living-room': {
    imageSize: { width: 1024, height: 1024 },
    wall:  { corners: [[0, 0],   [1024, 0],   [1024, 610], [0, 610]] },
    floor: { corners: [[0, 619], [1024, 619], [1024, 930], [0, 930]] }
  },
  'bathroom': {
    imageSize: { width: 1024, height: 1024 },
    wall:  { corners: [[0, 0],   [1024, 0],   [1024, 610], [0, 610]] },
    floor: { corners: [[0, 619], [1024, 619], [1024, 930], [0, 930]] }
  },
  'bedroom': {
    imageSize: { width: 1024, height: 1024 },
    wall:  { corners: [[0, 0],   [1024, 0],   [1024, 610], [0, 610]] },
    floor: { corners: [[0, 619], [1024, 619], [1024, 930], [0, 930]] }
  }
};
