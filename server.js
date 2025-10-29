// Importamos las herramientas necesarias
import serverless from 'serverless-http';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
// Usamos EXACTAMENTE la misma librería que funcionaba en Replit
import { GoogleGenAI, Modality } from '@google/genai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Verificamos la API Key (esto es crucial)
if (!process.env.GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY no está configurada en las variables de entorno de Netlify.');
  throw new Error('GEMINI_API_KEY is not set');
}

// Usamos EXACTAMENTE la misma configuración de IA que funcionaba en Replit
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_ID = 'gemini-1.5-flash'; // Usaremos 'gemini-1.5-flash' que es el sucesor compatible

// Helpers (de tu código original)
function parseDataUrlOrRaw(base64OrDataUrl) {
  const match = /^data:(.+?);base64,(.+)$/.exec(base64OrDataUrl || '');
  if (match) return { mime: match[1], b64: match[2] };
  return { mime: 'image/png', b64: base64OrDataUrl };
}

// ==== API Endpoint /api/generate ====
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

    // Usamos EXACTAMENTE la misma llamada a la API que funcionaba en Replit
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

    // Adaptación para Netlify: NO guardamos el archivo, lo devolvemos directamente
    const lastImage = images[images.length - 1];
    const imageUrl = `data:${lastImage.inlineData.mimeType};base64,${lastImage.inlineData.data}`;
    
    return res.json({ imageUrl: imageUrl });

  } catch (err) {
    console.error('Error en /api/generate:', err);
    return res.status(500).json({ error: err?.message || 'Error generando imagen' });
  }
});

// Exportamos el handler para que Netlify lo use
export const handler = serverless(app);