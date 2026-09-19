/* ============================================================
   server/index.js
   Four endpoints:
     POST /api/generate-tile         text -> seamless tile texture               [AI]
     POST /api/generate-tile-render  base room photo + mask(s) -> photoreal edit  [AI]  (3D Studio's AI panel)
     POST /api/photo-edit            photo (preset or upload) + one surface -> edited photo [AI] (Photo Mode, AI pane)
     POST /api/apply-tile-local      photo + quad corners + tile swatch -> composited photo [NON-AI] (Photo Mode, Non-AI pane)

   Provider calls are isolated behind generateImage()/editImage(),
   which dispatch to whichever provider AI_PROVIDER selects
   (generateWithGemini/editWithGemini, generateWithOpenAI/editWithOpenAI,
   or generateWithHuggingFace/editWithHuggingFace). Route handlers only ever
   call generateImage()/editImage().

   /api/apply-tile-local is intentionally kept outside that dispatch
   entirely — it never imports or calls generateImage()/editImage(),
   so it keeps working even if both AI providers are unreachable or
   unconfigured (see local-tile-engine.js).
   ============================================================ */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const fssync = require('fs');
const sharp = require('sharp');
const { applyPerspectiveTile } = require('./local-tile-engine');

const PORT = process.env.PORT || 3000;
const AI_PROVIDER = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-image';
const HF_TOKEN = process.env.HF_TOKEN;
const HF_MODEL = process.env.HF_MODEL || 'black-forest-labs/FLUX.1-Kontext-dev';
const HF_GENERATE_MODEL = process.env.HF_GENERATE_MODEL || 'black-forest-labs/FLUX.1-dev';
const HF_VISION_MODEL = process.env.HF_VISION_MODEL || 'CohereLabs/command-a-vision-07-2025';
const HF_VISION_PROVIDER = process.env.HF_VISION_PROVIDER || 'auto';
/* HF_VISION_MODEL is tried first, then these — in order — as automatic
   fallbacks. This exists because vision-model <-> provider mappings on
   Hugging Face's router change often and vary by account (which providers
   you've enabled at hf.co/settings/inference-providers, gated-model access,
   etc.), so one model/provider combo failing shouldn't take the whole
   feature down with no retry. CohereLabs/command-a-vision-07-2025 (via
   Cohere) is Hugging Face's own current documented example for the
   image-text-to-text task, so it's first; the Qwen models are kept as
   fallbacks in case your account's provider mappings support them even
   though they weren't reachable when this default was last checked.
   Override the whole chain with HF_VISION_MODEL_FALLBACKS="model/a,model/b"
   in server/.env if needed. */
const HF_VISION_MODEL_FALLBACKS = (process.env.HF_VISION_MODEL_FALLBACKS
  ? process.env.HF_VISION_MODEL_FALLBACKS.split(',').map(m => m.trim()).filter(Boolean)
  : ['Qwen/Qwen2.5-VL-7B-Instruct', 'Qwen/Qwen2.5-VL-3B-Instruct']
).filter(m => m !== HF_VISION_MODEL);
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---------- provider dispatch ---------- */
function normalizeProvider(value){
  const provider = String(value || AI_PROVIDER).toLowerCase();
  if(!['huggingface','gemini','openai'].includes(provider)){
    throw new Error(`Unsupported AI provider "${provider}". Use huggingface, gemini, or openai.`);
  }
  return provider;
}
function generateImage(prompt, opts = {}){
  const provider = normalizeProvider(opts.provider);
  if (provider === 'huggingface') return generateWithHuggingFace(prompt, opts);
  if (provider === 'openai') return generateWithOpenAI(prompt, opts);
  return generateWithGemini(prompt, opts);
}
function editImage(imageBuffer, maskBuffer, prompt, opts = {}){
  const provider = normalizeProvider(opts.provider);
  if (provider === 'huggingface') return editWithHuggingFace(imageBuffer, maskBuffer, prompt, opts);
  if (provider === 'openai') return editWithOpenAI(imageBuffer, maskBuffer, prompt, opts);
  return editWithGemini(imageBuffer, maskBuffer, prompt, opts);
}

/* ---------- provider: Hugging Face Inference Providers ---------- */
/* Uses the official @huggingface/inference client so provider routing,
   request formatting, and image-to-image handling are kept in sync with
   Hugging Face's current Inference Providers API. */
const { InferenceClient } = require('@huggingface/inference');
const hfClient = HF_TOKEN ? new InferenceClient(HF_TOKEN) : null;

async function hfOutputToBase64(output, label){
  if(output == null){
    throw new Error(`Hugging Face returned no image for ${label}. Check that the selected model is available through Inference Providers and that your token has Inference Providers permission.`);
  }

  // Current @huggingface/inference normally returns a Blob for image tasks.
  if(typeof output.arrayBuffer === 'function'){
    return Buffer.from(await output.arrayBuffer()).toString('base64');
  }

  // Be tolerant of older/client configurations that return a data URL or URL.
  if(typeof output === 'string'){
    if(output.startsWith('data:image/')) return output.split(',')[1];
    if(/^https?:\/\//i.test(output)){
      const res = await fetch(output);
      if(!res.ok) throw new Error(`Hugging Face image URL fetch failed (${res.status}).`);
      return Buffer.from(await res.arrayBuffer()).toString('base64');
    }
  }

  if(Buffer.isBuffer(output)) return output.toString('base64');
  if(output instanceof Uint8Array) return Buffer.from(output).toString('base64');

  throw new Error(`Hugging Face returned an unsupported image response for ${label}.`);
}

/* The @huggingface/inference client throws InferenceClientProviderApiError
   whenever the underlying HTTP request to the routed provider fails — but
   its own .message is always the same generic "Failed to perform inference:
   an HTTP error occurred when requesting the provider.", regardless of
   whether the real cause was a bad token (401), an unpaid/exhausted quota
   (402/429), a gated model needing ToS acceptance (403), or the provider
   being down (5xx). The actual reason lives on err.httpResponse.status /
   .body and err.httpRequest.url, which the client never surfaces on its
   own. Pulling those out turns "an HTTP error occurred" into something
   actually actionable — especially useful when the SAME generic message
   shows up across multiple unrelated models/providers, which points at an
   account/token/billing problem rather than any one model being down. */
function describeHfError(err){
  const status = err?.httpResponse?.status;
  const url = err?.httpRequest?.url;
  let body = err?.httpResponse?.body;
  if(body && typeof body !== 'string'){
    try{ body = JSON.stringify(body); } catch{ body = String(body); }
  }
  const parts = [err?.message || String(err)];
  if(status) parts.push(`HTTP ${status}`);
  if(url) parts.push(`endpoint: ${url}`);
  if(body) parts.push(`response: ${String(body).slice(0,300)}`);
  return parts.join(' — ');
}

async function generateWithHuggingFace(prompt){
  if(!hfClient) throw new Error('HF_TOKEN is not set on the server. Add it to server/.env.');
  let imageOutput;
  try{
    imageOutput = await hfClient.textToImage(
      {
        model: HF_GENERATE_MODEL,
        inputs: prompt,
        provider: 'auto'
      },
      { outputType: 'blob' }
    );
  } catch(err){
    // The @huggingface/inference client sometimes throws a bare, unhelpful
    // TypeError (e.g. "Cannot read properties of undefined (reading
    // 'arrayBuffer')") when the underlying provider rejects the request —
    // model unavailable, no Inference Providers permission on the token,
    // rate-limited, etc. Surface something a person can actually act on.
    throw new Error(`Hugging Face text-to-image request failed (model "${HF_GENERATE_MODEL}"): ${describeHfError(err)}. Check that the model is available through Inference Providers and that HF_TOKEN has Inference Providers permission.`);
  }
  return hfOutputToBase64(imageOutput, 'text-to-image');
}

async function editWithHuggingFace(imageBuffer, maskBuffer, prompt){
  if(!hfClient) throw new Error('HF_TOKEN is not set on the server. Add it to server/.env.');

  /* FLUX Kontext is an image+text editing workflow. The mask is not passed
     as a separate inpainting mask because the model's image-editing task
     uses the source image plus the instruction. */
  const imageBlob = new Blob([imageBuffer], { type: 'image/png' });

  let imageOutput;
  try{
    imageOutput = await hfClient.imageToImage({
      inputs: imageBlob,
      model: HF_MODEL,
      parameters: { prompt },
      provider: 'auto'
    });
  } catch(err){
    throw new Error(`Hugging Face image-to-image request failed (model "${HF_MODEL}"): ${describeHfError(err)}. Check that the model is available through Inference Providers and that HF_TOKEN has Inference Providers permission.`);
  }

  return hfOutputToBase64(imageOutput, 'image-to-image');
}

/* ---------- provider: Google Gemini ("Nano Banana") — default, free tier ---------- */
/* Gemini's image model is multimodal in both directions: one
   generateContent call can take text only (generation) or text +
   an inline image (editing) and returns an image part in the
   response either way. There's no separate "edits" endpoint and no
   mask parameter — editing is just "send the image and describe the
   change", which is actually a closer match to how this app already
   talks to an edit endpoint (see editWithOpenAI's mask-less calls in
   /api/photo-edit) than OpenAI's mask-based inpainting is. */
/* Google renames/promotes these image-model IDs fairly often (the
   "-preview" suffix in particular has come and gone), so a 404 here
   usually means GEMINI_MODEL is stale rather than anything wrong with
   the request — surface that instead of a bare API error. */
function geminiErrorMessage(data, status){
  const raw = data.error?.message || `Gemini request failed (${status})`;
  if(status === 404 && /not found|not supported/i.test(raw)){
    return `${raw} — the model name "${GEMINI_MODEL}" may have changed. Check ` +
      `https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY for current ` +
      `image-capable models, then set GEMINI_MODEL in server/.env.`;
  }
  return raw;
}

function extractGeminiImageBase64(data){
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData && p.inlineData.data);
  if(!imagePart){
    const textPart = parts.find(p => p.text);
    throw new Error(
      textPart
        ? `Gemini replied with text instead of an image: "${textPart.text.slice(0,120)}"`
        : 'Gemini did not return an image. Try rewording the prompt.'
    );
  }
  return imagePart.inlineData.data;
}

async function generateWithGemini(prompt){
  if(!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set on the server. Add it to server/.env.');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${prompt} Square image, 1:1 aspect ratio.` }] }]
    })
  });
  const data = await res.json();
  if(!res.ok) throw new Error(geminiErrorMessage(data, res.status));
  return extractGeminiImageBase64(data);
}

/* maskBuffer is accepted for signature-compatibility with
   editWithOpenAI but ignored — Gemini has no mask input, so the
   prompt's wording is the only thing constraining the edit. */
async function editWithGemini(imageBuffer, maskBuffer, prompt){
  if(!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set on the server. Add it to server/.env.');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType: 'image/png', data: imageBuffer.toString('base64') } }
        ]
      }]
    })
  });
  const data = await res.json();
  if(!res.ok) throw new Error(geminiErrorMessage(data, res.status));
  return extractGeminiImageBase64(data);
}

/* ---------- provider: OpenAI images API — alternate, set AI_PROVIDER=openai ---------- */
/* generateWithOpenAI: plain text-to-image, used for custom tile textures. */
async function generateWithOpenAI(prompt, { size = '1024x1024' } = {}){
  if(!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set on the server. Add it to server/.env.');
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size,
      n: 1
    })
  });
  const data = await res.json();
  if(!res.ok) throw new Error(data.error?.message || `OpenAI generation failed (${res.status})`);
  return data.data[0].b64_json;
}

/* editWithOpenAI: mask-based inpainting — only the white area of
   `maskBuffer` is regenerated, everything black is preserved
   pixel-for-pixel. This is why the photo doesn't "redraw the room"
   on every tile swap: lighting, shadows, camera, and furniture all
   sit outside the mask. */
async function editWithOpenAI(imageBuffer, maskBuffer, prompt, { size = '1024x1024' } = {}){
  if(!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set on the server. Add it to server/.env.');
  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('image', new Blob([imageBuffer], { type: 'image/png' }), 'room.png');
  if(maskBuffer){
    form.append('mask', new Blob([maskBuffer], { type: 'image/png' }), 'mask.png');
  }
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('n', '1');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: form
  });
  const data = await res.json();
  if(!res.ok) throw new Error(data.error?.message || `OpenAI edit failed (${res.status})`);
  return data.data[0].b64_json;
}


/* ---------- AI room analysis ------------------------------------------ */
/* AI is used here for GEOMETRY, not for painting the room. The model returns
   normalized surface polygons/quads. The browser then feeds those coordinates
   into the deterministic Tile Studio renderer. This keeps the selected catalog
   tile pixel-controlled instead of asking an image generator to invent it. */
function extractJsonObject(text){
  if(typeof text !== 'string') throw new Error('AI analysis returned no text.');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if(start < 0 || end <= start) throw new Error(`AI analysis did not return JSON: ${text.slice(0,240)}`);
  try { return JSON.parse(candidate.slice(start, end + 1)); }
  catch(err){ throw new Error(`AI analysis returned invalid JSON: ${err.message}`); }
}

function clamp01(v){ return Math.max(0, Math.min(1, Number(v) || 0)); }
function normalizeAnalysis(raw){
  const normPoint = p => Array.isArray(p) ? [clamp01(Number(p[0]) / 1000), clamp01(Number(p[1]) / 1000)] : null;
  const cleanSurface = (src) => {
    if(!src || src.detected === false) return null;
    const poly = Array.isArray(src.polygon) ? src.polygon.map(normPoint).filter(Boolean) : [];
    const corners = Array.isArray(src.corners) ? src.corners.map(normPoint).filter(Boolean) : [];
    if(poly.length < 3 || corners.length !== 4) return null;
    const obstacles = Array.isArray(src.obstacles) ? src.obstacles.map(o =>
      Array.isArray(o) ? o.map(normPoint).filter(Boolean) : []
    ).filter(p => p.length >= 3).slice(0, 12) : [];
    return { polygon: poly, corners, obstacles };
  };
  return { floor: cleanSurface(raw.floor), wall: cleanSurface(raw.wall), notes: String(raw.notes || '').slice(0,500) };
}

const ROOM_ANALYSIS_INSTRUCTIONS = `Analyze this room photograph for a tile visualization tool. Do NOT generate or edit the image. Return ONLY JSON. Coordinates must use a 0..1000 coordinate system where x=0 is the left edge, x=1000 right edge, y=0 top, y=1000 bottom. Identify the visible floor and wall surfaces that are suitable for tile placement. For each detected surface return: polygon (3+ points tracing the visible paintable boundary), corners (exactly 4 points defining the underlying rectangular plane in order top-left, top-right, bottom-right, bottom-left), and obstacles (0..12 polygons for furniture/objects that must remain untouched). If a true surface is not visible, set detected:false. Do not use image-generation language. Return exactly this shape: {"floor":{"detected":true,"polygon":[[x,y],...],"corners":[[x,y],[x,y],[x,y],[x,y]],"obstacles":[[[x,y],...]]},"wall":{"detected":true,"polygon":[[x,y],...],"corners":[[x,y],[x,y],[x,y],[x,y]],"obstacles":[]},"notes":"..."}`;

async function analyzeWithHuggingFace(imageBuffer){
  if(!hfClient) throw new Error('HF_TOKEN is not set on the server. Add it to server/.env.');
  const dataUrl = `data:image/jpeg;base64,${(await sharp(imageBuffer).resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).jpeg({quality:82}).toBuffer()).toString('base64')}`;

  const modelsToTry = [HF_VISION_MODEL, ...HF_VISION_MODEL_FALLBACKS];
  const failures = [];

  for(const model of modelsToTry){
    let out;
    try{
      out = await hfClient.chatCompletion({
        model,
        provider: HF_VISION_PROVIDER,
        messages: [{ role:'user', content:[
          { type:'text', text: ROOM_ANALYSIS_INSTRUCTIONS },
          { type:'image_url', image_url:{ url:dataUrl } }
        ]}],
        temperature: 0,
        max_tokens: 1800
      });
    } catch(err){
      const detail = describeHfError(err);
      console.warn(`[analyze-room] Hugging Face model "${model}" (provider "${HF_VISION_PROVIDER}") failed, ${model === modelsToTry[modelsToTry.length-1] ? 'no more fallbacks' : 'trying next fallback'}: ${detail}`);
      failures.push(`"${model}": ${detail}`);
      continue;
    }

    const content = out?.choices?.[0]?.message?.content || '';
    try{
      // Parse here (not just after the loop) so a model that responds but
      // returns unusable text also falls through to the next model instead
      // of surfacing a confusing "invalid JSON" error from a model that
      // was never really the problem.
      return extractJsonObject(content);
    } catch(err){
      console.warn(`[analyze-room] Hugging Face model "${model}" responded but didn't return usable JSON, ${model === modelsToTry[modelsToTry.length-1] ? 'no more fallbacks' : 'trying next fallback'}: ${err.message}`);
      failures.push(`"${model}": ${err.message}`);
      continue;
    }
  }

  throw new Error(`Hugging Face room analysis failed on all configured models (${failures.length}): ${failures.join(' | ')}. Set HF_VISION_MODEL/HF_VISION_MODEL_FALLBACKS/HF_VISION_PROVIDER in server/.env if your account exposes different vision models or providers.`);
}

async function analyzeWithGemini(imageBuffer){
  if(!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set on the server. Add it to server/.env.');
  const resized = await sharp(imageBuffer).resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).jpeg({quality:82}).toBuffer();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent`, {
    method:'POST', headers:{'x-goog-api-key':GEMINI_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({contents:[{parts:[{text:ROOM_ANALYSIS_INSTRUCTIONS},{inlineData:{mimeType:'image/jpeg',data:resized.toString('base64')}}]}], generationConfig:{temperature:0}})
  });
  const data=await res.json();
  if(!res.ok) throw new Error(geminiErrorMessage(data,res.status));
  return extractJsonObject(data?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('') || '');
}

async function analyzeWithOpenAI(imageBuffer){
  if(!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set on the server. Add it to server/.env.');
  const resized = await sharp(imageBuffer).resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).jpeg({quality:82}).toBuffer();
  const res=await fetch('https://api.openai.com/v1/chat/completions',{
    method:'POST', headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:OPENAI_VISION_MODEL,temperature:0,max_tokens:1800,response_format:{type:'json_object'},messages:[{role:'user',content:[{type:'text',text:ROOM_ANALYSIS_INSTRUCTIONS},{type:'image_url',image_url:{url:`data:image/jpeg;base64,${resized.toString('base64')}`}}]}]})
  });
  const data=await res.json();
  if(!res.ok) throw new Error(data.error?.message || `OpenAI room analysis failed (${res.status})`);
  return extractJsonObject(data?.choices?.[0]?.message?.content || '');
}

app.post('/api/analyze-room', async (req,res)=>{
  try{
    const { baseImage, provider } = req.body || {};
    if(!baseImage || typeof baseImage !== 'string' || !baseImage.startsWith('data:image/')) return res.status(400).json({error:'Missing or invalid baseImage.'});
    const buf=Buffer.from(baseImage.slice(baseImage.indexOf(',')+1),'base64');
    let raw;
    const p=normalizeProvider(provider);
    if(p==='huggingface') raw=await analyzeWithHuggingFace(buf);
    else if(p==='gemini') raw=await analyzeWithGemini(buf);
    else raw=await analyzeWithOpenAI(buf);
    const analysis=normalizeAnalysis(raw);
    if(!analysis.floor && !analysis.wall) throw new Error('AI could not find a usable floor or wall surface. Try a clearer room photo or use Manual/Non-AI mode.');
    res.json({analysis, provider:p, model:p==='huggingface'?HF_VISION_MODEL:p==='gemini'?GEMINI_VISION_MODEL:OPENAI_VISION_MODEL});
  }catch(err){ console.error('[analyze-room]',err); res.status(500).json({error:err.message||'Room analysis failed.'}); }
});

/* ---------- AI touch-up ----------------------------------------------- */
/* The AI result is NEVER used as the final tile layer. The browser uses it
   only as a lighting/shadow reference and transfers a tightly-clamped
   luminance adjustment back onto the deterministic render. */
app.post('/api/ai-touchup', async (req,res)=>{
  try{
    const { baseImage, provider }=req.body||{};
    if(!baseImage || typeof baseImage!=='string' || !baseImage.startsWith('data:image/')) return res.status(400).json({error:'Missing or invalid baseImage.'});
    const imageBuffer=Buffer.from(baseImage.slice(baseImage.indexOf(',')+1),'base64');
    const prompt=[
      'Improve only the photographic integration of the already-installed floor and/or wall tile in this image.',
      'Do NOT redesign, replace, repaint, move, resize, rotate, recolor, or invent any tile.',
      'Do NOT alter grout positions, tile boundaries, room geometry, furniture, architecture, windows, decor, or camera perspective.',
      'Only make subtle realistic lighting, ambient shadow, reflection, contact shading, and color-blending adjustments that would make the existing installation look naturally photographed.',
      'Return the same composition and preserve the exact tile pattern and grout layout.'
    ].join(' ');
    const b64=await editImage(imageBuffer,null,prompt,{provider:normalizeProvider(provider),size:'1024x1024'});
    res.json({imageBase64:b64});
  }catch(err){ console.error('[ai-touchup]',err); res.status(500).json({error:err.message||'AI touch-up failed.'}); }
});

/* ---------- POST /api/generate-tile ---------- */
/* Text -> seamless PBR-ready tile texture. The prompt is built so
   the result tiles cleanly and reads as a flat material swatch,
   not a photo of a room, since the frontend re-derives normal/
   roughness maps from this image with a Sobel filter. */
app.post('/api/generate-tile', async (req, res) => {
  try{
    const { prompt, target, provider } = req.body || {};
    if(!prompt || typeof prompt !== 'string' || !prompt.trim()){
      return res.status(400).json({ error: 'A tile description is required.' });
    }
    const surface = target === 'wall' ? 'wall tile' : 'floor tile';
    const fullPrompt = [
      `A seamless, tileable, top-down texture photo of a ${surface} material: ${prompt.trim()}.`,
      'Flat, even studio lighting, no shadows, no perspective, no room, no furniture, fills the entire frame edge to edge, photographed straight-on like a material sample swatch.'
    ].join(' ');

    const b64 = await generateImage(fullPrompt, { size: '1024x1024', provider });
    res.json({ imageBase64: b64 });
  } catch(err){
    console.error('[generate-tile]', err);
    res.status(500).json({ error: err.message || 'Tile generation failed.' });
  }
});

/* ---------- POST /api/generate-tile-render ---------- */
/* Room photo + tile selection -> photoreal edit. Requires the
   person to have supplied, per room:
     server/rooms/<room>.png        the base photo (square, e.g. 1024x1024)
     server/masks/<room>-floor.png  white = floor area, black = rest
     server/masks/<room>-wall.png   white = wall area, black = rest
   Runs up to two sequential edits (floor, then wall) so each mask
   only ever touches its own surface; a room with only one mask
   present just runs that one edit.
   Note: with AI_PROVIDER=gemini (the default), the mask *files* still
   gate whether an edit runs at all, but Gemini itself never sees the
   mask's pixels — it has no mask input, so only the prompt's wording
   constrains which surface changes. Switch AI_PROVIDER=openai for
   true pixel-masked inpainting. */
app.post('/api/generate-tile-render', async (req, res) => {
  try{
    const { room, floorDesc, wallDesc, provider } = req.body || {};
    if(!room) return res.status(400).json({ error: 'Missing room.' });

    const roomPath = path.join(__dirname, 'rooms', `${room}.png`);
    if(!fssync.existsSync(roomPath)){
      return res.status(400).json({
        error: `Missing base photo: server/rooms/${room}.png. See README for how to add one.`
      });
    }

    const floorMaskPath = path.join(__dirname, 'masks', `${room}-floor.png`);
    const wallMaskPath = path.join(__dirname, 'masks', `${room}-wall.png`);
    const hasFloorMask = fssync.existsSync(floorMaskPath);
    const hasWallMask = fssync.existsSync(wallMaskPath);
    if(!hasFloorMask && !hasWallMask){
      return res.status(400).json({
        error: `Missing masks for "${room}": add server/masks/${room}-floor.png and/or server/masks/${room}-wall.png (white = editable area, black = protected). See README.`
      });
    }

    let currentImage = await fs.readFile(roomPath);
    const preserveClause = 'Keep the camera angle, lighting, shadows, furniture, and every other surface exactly as in the original photo — only change the texture of the masked area.';

    if(hasFloorMask && floorDesc){
      const mask = await fs.readFile(floorMaskPath);
      const b64 = await editImage(
        currentImage, mask,
        `Replace the floor surface with realistic ${floorDesc}, photographed under the room's existing lighting. ${preserveClause}`,
        { provider }
      );
      currentImage = Buffer.from(b64, 'base64');
    }
    if(hasWallMask && wallDesc){
      const mask = await fs.readFile(wallMaskPath);
      const b64 = await editImage(
        currentImage, mask,
        `Replace the wall surface with realistic ${wallDesc}, photographed under the room's existing lighting. ${preserveClause}`,
        { provider }
      );
      currentImage = Buffer.from(b64, 'base64');
    }

    res.json({ imageBase64: currentImage.toString('base64') });
  } catch(err){
    console.error('[generate-tile-render]', err);
    res.status(500).json({ error: err.message || 'Render failed.' });
  }
});

/* ---------- POST /api/photo-edit ---------- */
/* Photo Mode's endpoint: one surface edit on a photo the browser
   already has in hand (a preset shipped in public/assets/presets/,
   or a photo the person uploaded) — sent up as a data URL either way,
   so the server treats presets and uploads identically.

   Unlike /api/generate-tile-render, this never requires a hand-made
   mask: it relies on gpt-image-1's own edit behavior plus a strongly
   worded "leave everything else alone" instruction. That trade-off is
   what makes "upload any photo of your own room" possible without
   asking the person to paint a mask first — at some cost to how
   perfectly the untouched areas are preserved compared to a real mask. */
app.post('/api/photo-edit', async (req, res) => {
  try{
    const { baseImage, target, desc, provider } = req.body || {};
    if(!baseImage || typeof baseImage !== 'string' || !baseImage.startsWith('data:image/')){
      return res.status(400).json({ error: 'Missing or invalid baseImage (expected a data URL).' });
    }
    if(!desc || typeof desc !== 'string' || !desc.trim()){
      return res.status(400).json({ error: 'Missing tile description.' });
    }
    const surface = target === 'wall' ? 'wall' : 'floor';
    const base64 = baseImage.slice(baseImage.indexOf(',') + 1);
    const imageBuffer = Buffer.from(base64, 'base64');

    const prompt = [
      `In this photo of a room, replace ONLY the ${surface} surface with realistic ${desc.trim()}, matching the room's existing lighting and camera angle.`,
      `Do not change anything else — keep every other surface, all furniture, walls${surface==='wall'?'':' and wall decor'}, windows, and the overall composition exactly as they are in the original photo.`
    ].join(' ');

    const b64 = await editImage(imageBuffer, null, prompt, { size: '1024x1024', provider });
    res.json({ imageBase64: b64 });
  } catch(err){
    console.error('[photo-edit]', err);
    res.status(500).json({ error: err.message || 'Edit failed.' });
  }
});

/* ---------- Non-AI Mode (Photo Mode's local pane) ----------
   POST /api/apply-tile-local — Canvas API on the frontend already does
   this compositing entirely client-side with zero network calls, which
   is the primary path for Non-AI Mode. This endpoint is the same
   deterministic perspective-warp-and-blend algorithm (see
   local-tile-engine.js, a pure-JS port of public/js/local-tile.js +
   perspective.js) exposed server-side too, for architectural parity
   with the AI endpoints above and for any caller that wants the room
   processed server-side instead of in-browser (e.g. batch/automation).

   This route NEVER calls generateImage()/editImage() or touches
   GEMINI_API_KEY/OPENAI_API_KEY — it only calls `sharp` (raster
   decode/encode) and local-tile-engine.js (plain array math). If the
   AI provider is down or unconfigured, this endpoint is completely
   unaffected. */
app.post('/api/apply-tile-local', async (req, res) => {
  try{
    const { baseImage, layers } = req.body || {};
    if(!baseImage || typeof baseImage !== 'string' || !baseImage.startsWith('data:image/')){
      return res.status(400).json({ error: 'Missing or invalid baseImage (expected a data URL).' });
    }
    if(!Array.isArray(layers) || layers.length === 0){
      return res.status(400).json({ error: 'Missing layers (expected at least one {corners, patternImage} entry).' });
    }

    const roomBuf = Buffer.from(baseImage.slice(baseImage.indexOf(',') + 1), 'base64');
    const { data: roomData, info } = await sharp(roomBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height;

    for(const layer of layers){
      const { corners, maskPoints, patternImage, repeatU, repeatV, rotationDeg, opacity, feather } = layer || {};
      if(!corners || !Array.isArray(corners) || corners.length !== 4){
        return res.status(400).json({ error: 'Each layer needs 4 corners: [[x,y],[x,y],[x,y],[x,y]].' });
      }
      if(!patternImage || typeof patternImage !== 'string' || !patternImage.startsWith('data:image/')){
        return res.status(400).json({ error: 'Each layer needs a patternImage data URL (the tile swatch to warp in).' });
      }
      const patBuf = Buffer.from(patternImage.slice(patternImage.indexOf(',') + 1), 'base64');
      const { data: patData, info: patInfo } = await sharp(patBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      applyPerspectiveTile(roomData, w, h, patData, patInfo.width, patInfo.height, { corners, maskPoints, repeatU, repeatV, rotationDeg, opacity, feather });
    }

    const outBuf = await sharp(roomData, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    res.json({ imageBase64: outBuf.toString('base64') });
  } catch(err){
    console.error('[apply-tile-local]', err);
    res.status(500).json({ error: err.message || 'Local tile processing failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`Tile Studio running at http://localhost:${PORT}`);
  console.log(`AI provider: ${AI_PROVIDER}`);
  const activeKey = AI_PROVIDER === 'openai' ? OPENAI_API_KEY
    : AI_PROVIDER === 'huggingface' ? HF_TOKEN
    : GEMINI_API_KEY;
  const activeKeyName = AI_PROVIDER === 'openai' ? 'OPENAI_API_KEY'
    : AI_PROVIDER === 'huggingface' ? 'HF_TOKEN'
    : 'GEMINI_API_KEY';
  if(!activeKey) console.warn(`⚠️  ${activeKeyName} is not set — AI endpoints will return an error until server/.env is filled in.`);
});
