# Tile Studio 1

Two ways to try tiles on a room, picked from a home screen:

- **Photo Mode** — one real photo (a preset or your own upload), edited
  surface-by-surface. Everything else in the photo stays as it was.
- **3D Mode** — the original real-time Three.js room: instant, orbitable,
  free re-tiling, no API calls needed at all.

```
public/
  index.html    home screen — choose a mode
  photo.html    Photo Mode
  studio.html   3D Mode (this is the same app from earlier versions, unchanged)
```

---

## Running it

```bash
cd server
cp .env.example .env
```

Open `.env` and add a **free** Gemini key from
[aistudio.google.com/apikey](https://aistudio.google.com/apikey):
```
GEMINI_API_KEY=AIza...
```
(`AI_PROVIDER=gemini` is already the default in `.env.example` — Gemini's
`gemini-2.5-flash-image` ("Nano Banana") is free with a daily quota,
no billing setup required. See "Switching AI providers" below to use OpenAI
instead.)

> **If you get a "model not found" error:** Google renames/promotes these
> image-model IDs periodically. The error message will point you to
> `https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY` —
> open that URL, find a model with `generateContent` in its supported
> methods and "image" in its name, and set `GEMINI_MODEL=<that name>` in
> `server/.env`.

```bash
npm install
npm start
```

Open `http://localhost:3000`. 3D Mode works with no key at all (it never
calls the AI); Photo Mode needs the key for every edit, since each tile
click is a real image-edit API call.

(You can still run `npx serve public` for 3D Mode alone with zero setup —
see the "3D Mode only" section below — but Photo Mode always needs the
Express server, since editing a photo means calling out to an AI provider.)

---

## Switching AI providers

Both AI features (`/api/generate-tile`, `/api/photo-edit`,
`/api/generate-tile-render`) go through one dispatcher in
`server/index.js` — `generateImage()` / `editImage()` — that picks a
provider based on `AI_PROVIDER` in `.env`:

- **`AI_PROVIDER=gemini`** (default) — free tier, no mask support (see
  "Why no masks here" below for what that trades off)
- **`AI_PROVIDER=openai`** — needs `OPENAI_API_KEY`, costs per call, but
  supports real pixel-masked inpainting for `/api/generate-tile-render`

Adding a third provider (Replicate, Stability, etc.) means writing one
`generateWithX()` / `editWithX()` pair with the same signature as the
existing ones and adding one line to the two dispatcher functions —
nothing in the route handlers themselves needs to change.

---

## Photo Mode — accuracy-first pipeline

Photo Mode now deliberately separates **room understanding**, **tile placement**, and **optional AI touch-up**:

```text
Room photo
   ↓
AI room analysis
   ↓
Surface mask + perspective corners + obstacle polygons
   ↓
Deterministic Tile Studio renderer
   ↓
Exact catalog tile + exact grout + perspective
   ↓
[ AI TOUCH-UP ] (optional)
   ↓
Lighting/shadow reference only
```

### AI room analysis

The selected provider returns structured geometry rather than a replacement room image. The browser converts normalized coordinates to the original image size and uses the existing perspective renderer. Floor/wall obstacle polygons are excluded from the tile layer so furniture remains untouched.

Supported analysis providers:

- Hugging Face — `HF_VISION_MODEL` (default `Qwen/Qwen2.5-VL-3B-Instruct`)
- Gemini — `GEMINI_VISION_MODEL`
- OpenAI — `OPENAI_VISION_MODEL`

### Deterministic tile placement

The selected catalog tile is rendered by `public/js/local-tile.js`. The AI output is never used as the final tile texture. This means changing the tile cannot cause a generative model to redesign the room.

### AI TOUCH-UP

`AI TOUCH-UP` is explicit and optional. The provider sees the deterministic result and is asked for subtle photographic integration. The returned image is **not** displayed directly. The browser extracts a tightly clamped luminance adjustment from the AI result and applies that adjustment to the deterministic render inside the detected surfaces. The exact tile pattern, grout, perspective, and room pixels remain protected.

If touch-up fails, the accurate deterministic render remains available.

### Non-AI Mode

Non-AI Mode remains completely local and deterministic. It uses the same tile renderer with manually supplied geometry.

### 3D Mode

3D Mode remains separate and continues to work without an AI key.
