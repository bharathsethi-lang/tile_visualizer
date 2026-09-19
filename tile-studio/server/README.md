# Tile Studio server

## AI providers

Set `AI_PROVIDER` in `.env` to one of:

- `huggingface`
- `gemini`
- `openai`

For Hugging Face:

```env
AI_PROVIDER=huggingface
HF_TOKEN=hf_...
HF_MODEL=black-forest-labs/FLUX.1-Kontext-dev
```

The server uses the official `@huggingface/inference` client and automatic Inference Provider routing.

Room analysis (`/api/analyze-room`, used to find the floor/wall for AI mode) is a vision call and is less reliable than the image endpoints — some free vision models are only served by a single Inference Provider, so if that provider has a bad moment the whole call fails with no retry. To make that resilient, the server tries `HF_VISION_MODEL` first, then automatically falls back through `HF_VISION_MODEL_FALLBACKS` (comma-separated model IDs) until one responds with usable JSON. Defaults are set in `.env.example`; override either if your account exposes different vision models.

Install dependencies with:

```powershell
npm install
```

Then:

```powershell
npm start
```

Never commit `.env` or share API tokens.
