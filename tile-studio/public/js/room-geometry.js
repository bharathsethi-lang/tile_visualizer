/* ============================================================
   room-geometry.js — Non-AI Mode preset geometry.
   Coordinates are in the sample room's natural image pixels.
   ============================================================ */

const ROOM_GEOMETRY = {
  'sample-living-room': {
    imageSize: { width: 2048, height: 1365 },
    // Four anchor corners define the perspective plane. Additional points
    // trace around visible furniture so the preset remains a useful demo.
    floor: {
      points: [
        [690, 770],
        [1450, 770],
        [2018, 1360],
        [80, 1360],
        [505, 1075, 3],
        [260, 880, 3]
      ],
      // Explicit perspective plane for the sample room. The four anchors
      // are kept separate from the mask-only points above so the preset
      // behaves exactly like an uploaded room.
      plane: [
        [690, 770],
        [1450, 770],
        [2018, 1360],
        [80, 1360]
      ]
    },
    wall: {
      points: [
        [0, 0],
        [2048, 0],
        [1450, 770],
        [690, 770]
      ]
    }
  }
};
