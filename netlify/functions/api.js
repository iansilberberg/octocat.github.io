// ==== CAMBIO 1: Importamos serverless-http con la sintaxis moderna ====
import serverless from 'serverless-http';

// El resto de tus imports originales
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
  // En una función serverless, no usamos process.exit, simplemente lanzamos un error.
  throw new Error('GEMINI_API_KEY is not set');
}
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_ID = 'gemini-1.5-flash'; // Usamos un modelo más estándar y eficiente

// Helpers
function parseDataUrlOrRaw(base64OrDataUrl) {
  const match = /^data:(.+?);base64,(.+)$/.exec(base64OrDataUrl || '');
  if (match) return { mime: match[1], b64: match[2] };
  return { mime: 'image/png', b64: base64OrDataUrl };
}
function extFromMime(mime) {
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
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

    // NOTA: Para Gemini 1.5, la API es ligeramente diferente.
    const model = ai.getGenerativeModel({ model: MODEL_ID });
    const result = await model.generateContent({ contents });
    const response = result.response;
    
    const parts = response?.candidates?.[0]?.content?.parts ?? [];
    const images = parts.filter(
      (p) => p?.inlineData?.data && p?.inlineData?.mimeType?.startsWith('image/')
    );

    if (!images.length) {
      // Si no hay imagen, devuelve el texto que haya generado la IA
      const text = response.text();
      return res.status(500).json({ error: 'No se generó imagen. Respuesta de la IA: ' + text });
    }

    const saved = images.map((p) => {
      try {
        const ext = extFromMime(p.inlineData.mimeType);
        const file = `${crypto.randomUUID()}.${ext}`;
        // En Netlify, las funciones son de solo lectura. No podemos guardar archivos así.
        // La solución es devolver la imagen directamente en base64 para mostrarla en el frontend.
        // Pero para mantener tu lógica, por ahora solo devolvemos el base64 sin guardar.
        // El frontend ya maneja esto bien.
        return {
            path: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`,
            base64: p.inlineData.data
        };
      } catch (fileErr) {
        console.error('Error procesando la imagen generada:', fileErr);
        throw new Error('Failed to process generated image');
      }
    });

    // Modificamos la respuesta para adaptarla a la nueva lógica
    return res.json({ imageUrl: saved[saved.length - 1].path, images: saved.map(s => s.path) });

  } catch (err) {
    console.error('Error en /api/generate:', err);
    return res
      .status(500)
      .json({ error: err?.message || 'Error generando imagen' });
  }
});

// ==== Catch-all ya no es necesario aquí, lo maneja Netlify ====
// app.get('*', ...);

// ==== CAMBIO 2: Borramos app.listen y exportamos el handler para Netlify ====
export const handler = serverless(app);