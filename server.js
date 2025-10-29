// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GoogleGenAI, Modality } from '@google/genai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// ==== Static files (serve ./public) ====
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const OUT_DIR = path.join(PUBLIC_DIR, 'outputs');
fs.mkdirSync(OUT_DIR, { recursive: true });
app.use(express.static(PUBLIC_DIR));

// Root -> serve index.html explicitly too
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ==== Google GenAI ====
if (!process.env.GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY is not set in environment variables');
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_ID = 'gemini-2.5-flash-image';

// Helpers
function parseDataUrlOrRaw(base64OrDataUrl) {
  // Accept either "data:image/png;base64,AAAA..." OR "AAAA..."
  const match = /^data:(.+?);base64,(.+)$/.exec(base64OrDataUrl || '');
  if (match) return { mime: match[1], b64: match[2] };
  // Default MIME if only raw base64 is sent
  return { mime: 'image/png', b64: base64OrDataUrl };
}
function extFromMime(mime) {
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  if (mime.includes('svg')) return 'svg';
  return 'png';
}

// ==== API ====
app.post('/api/generate', async (req, res) => {
  try {
    const { imageBase64, prompt } = req.body || {};
    if (!imageBase64 || !prompt) {
      return res.status(400).json({ error: 'Falta imagen o prompt' });
    }

    const { mime, b64 } = parseDataUrlOrRaw(imageBase64);

    const contents = [
      { text: prompt },
      {
        inlineData: {
          mimeType: mime,
          data: b64,
        },
      },
    ];

    const gen = await ai.models.generateContent({
      model: MODEL_ID,
      contents,
      config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
    });

    const parts = gen?.candidates?.[0]?.content?.parts ?? [];
    const images = parts.filter(
      (p) => p?.inlineData?.data && p?.inlineData?.mimeType?.startsWith('image/')
    );

    if (!images.length) {
      return res.status(500).json({ error: 'No se generó imagen' });
    }

    // Guarda todas y devuelve la última (también devuelve el array por si lo querés usar)
    const saved = images.map((p) => {
      try {
        const ext = extFromMime(p.inlineData.mimeType);
        const file = `${crypto.randomUUID()}.${ext}`;
        fs.writeFileSync(
          path.join(OUT_DIR, file),
          Buffer.from(p.inlineData.data, 'base64')
        );
        return `/outputs/${file}`;
      } catch (fileErr) {
        console.error('Error saving generated image:', fileErr);
        throw new Error('Failed to save generated image');
      }
    });

    return res.json({ imageUrl: saved[saved.length - 1], images: saved });
  } catch (err) {
    console.error('Error en /api/generate:', err);
    return res
      .status(500)
      .json({ error: err?.message || 'Error generando imagen' });
  }
});

// ==== Catch-all: serve index.html for any unknown route (SPA support) ====
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ==== Start server (Replit/Render/etc.) ====
const PORT = Number(process.env.PORT) || 5000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`Servidor en http://localhost:${PORT}`)
);
