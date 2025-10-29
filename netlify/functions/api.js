import serverless from 'serverless-http';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// La línea que causaba el error (fs.mkdirSync) ha sido eliminada.
// Ya no necesitamos crear carpetas en el servidor.

// Verificamos la API Key de forma segura
if (!process.env.GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY no está configurada en las variables de entorno de Netlify.');
  throw new Error('GEMINI_API_KEY is not set');
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Helper para procesar la imagen
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
    
    const imagePart = {
      inlineData: {
        data: b64,
        mimeType: mime,
      },
    };

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    const parts = response?.candidates?.[0]?.content?.parts ?? [];

    const images = parts.filter(
      (p) => p?.inlineData?.data && p?.inlineData?.mimeType?.startsWith('image/')
    );

    if (!images.length) {
      const text = response.text();
      console.error("No se generó imagen. Respuesta de la IA:", text);
      return res.status(500).json({ error: 'No se generó imagen. Respuesta de la IA: ' + text });
    }
    
    // En lugar de guardar, devolvemos la imagen como un data URL.
    // Tu frontend ya está preparado para entender esto.
    const lastImage = images[images.length - 1];
    const imageUrl = `data:${lastImage.inlineData.mimeType};base64,${lastImage.inlineData.data}`;
    
    return res.json({ imageUrl: imageUrl });

  } catch (err) {
    console.error('Error en /api/generate:', err.message);
    return res.status(500).json({ error: err?.message || 'Error generando imagen' });
  }
});

// Exportamos el handler para que Netlify lo use
export const handler = serverless(app);