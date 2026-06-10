const crypto = require('node:crypto');
const path = require('node:path');
require('dotenv/config');
const express = require('express');
const cors = require('cors');
const { GoogleGenAI, Modality } = require('@google/genai');
const { authenticateAdmin, getAdminStatus, requireAdmin } = require('./admin-auth.js');
const {
  buildApproxLocation,
  createAdminStore,
  sanitizeClientMeta,
} = require('./admin-storage.js');

const MODEL_ID = 'gemini-2.5-flash-image';
const ALLOWED_EVENTS = new Set(['page_view', 'download_click', 'admin_open']);
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;

function parseDataUrlOrRaw(base64OrDataUrl) {
  const match = /^data:(.+?);base64,(.+)$/.exec(base64OrDataUrl || '');
  if (match) return { mime: match[1], b64: match[2] };
  return { mime: 'image/png', b64: base64OrDataUrl };
}

function dataUrl(mimeType, b64) {
  return `data:${mimeType};base64,${b64}`;
}

function cleanText(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeArtwork(artwork = {}) {
  return {
    id: cleanText(artwork.id, 80) || null,
    title: cleanText(artwork.title, 120) || null,
    src: cleanText(artwork.src, 180) || null,
  };
}

function referrerDomain(value) {
  try {
    return value ? new URL(value).hostname : null;
  } catch {
    return null;
  }
}

async function safeAddEvent(store, event) {
  try {
    await store.addEvent(event);
  } catch (error) {
    console.error('No se pudo guardar la metrica:', error);
  }
}

function makeAiClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function loginKey(req) {
  return String(req.get('x-forwarded-for') || req.ip || 'local').split(',')[0].trim();
}

function createLoginLimiter() {
  const attempts = new Map();

  return {
    check(req) {
      const key = loginKey(req);
      const now = Date.now();
      const current = attempts.get(key);
      if (!current || current.resetAt <= now) {
        attempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
        return true;
      }
      if (current.count >= LOGIN_MAX_ATTEMPTS) return false;
      current.count += 1;
      return true;
    },
    reset(req) {
      attempts.delete(loginKey(req));
    },
  };
}

function createApp({ serveStatic = false } = {}) {
  const app = express();
  const store = createAdminStore();
  const ai = makeAiClient();
  const loginLimiter = createLoginLimiter();

  app.use((req, _res, next) => {
    req.url = req.url.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '/api');
    next();
  });

  app.use(cors());
  app.use(express.json({ limit: '35mb' }));
  app.use('/api/admin', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      storage: store.driverName,
      admin: getAdminStatus(),
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  app.post('/api/generate', async (req, res) => {
    const clientMeta = sanitizeClientMeta(req.body?.clientMeta);
    const location = buildApproxLocation(req, clientMeta);
    const artwork = normalizeArtwork(req.body?.artwork);

    try {
      if (!ai) {
        return res.status(503).json({ error: 'GEMINI_API_KEY no esta configurada.' });
      }

      const { imageBase64, prompt } = req.body || {};
      const cleanPrompt = cleanText(prompt, 1600);
      if (!imageBase64 || !cleanPrompt) {
        return res.status(400).json({ error: 'Falta imagen o prompt' });
      }

      const { mime, b64 } = parseDataUrlOrRaw(imageBase64);
      const gen = await ai.models.generateContent({
        model: MODEL_ID,
        contents: [
          { text: cleanPrompt },
          {
            inlineData: {
              mimeType: mime,
              data: b64,
            },
          },
        ],
        config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
      });

      const parts = gen?.candidates?.[0]?.content?.parts ?? [];
      const images = parts.filter(
        (part) => part?.inlineData?.data && part?.inlineData?.mimeType?.startsWith('image/')
      );

      if (!images.length) {
        await safeAddEvent(store, {
          id: crypto.randomUUID(),
          type: 'generate_error',
          createdAt: new Date().toISOString(),
          artworkId: artwork.id,
          location,
          client: clientMeta,
          detail: 'No se genero imagen',
        });
        return res.status(500).json({ error: 'No se genero imagen' });
      }

      const lastImage = images[images.length - 1];
      const imageUrl = dataUrl(lastImage.inlineData.mimeType, lastImage.inlineData.data);
      const imageId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const imageRecord = {
        id: imageId,
        createdAt,
        artworkId: artwork.id,
        artworkTitle: artwork.title,
        artworkSrc: artwork.src,
        promptPreview: cleanPrompt.slice(0, 320),
        promptLength: cleanPrompt.length,
        mimeType: lastImage.inlineData.mimeType,
        bytes: Buffer.byteLength(lastImage.inlineData.data, 'base64'),
        location,
        client: clientMeta,
      };

      try {
        await store.addImage(
          imageRecord,
          {
            mimeType: lastImage.inlineData.mimeType,
            b64: lastImage.inlineData.data,
          }
        );

        await safeAddEvent(store, {
          id: crypto.randomUUID(),
          type: 'generate_success',
          createdAt,
          artworkId: artwork.id,
          imageId,
          location,
          client: clientMeta,
        });
      } catch (error) {
        console.error('No se pudo guardar la imagen generada:', error);
        await safeAddEvent(store, {
          id: crypto.randomUUID(),
          type: 'generate_error',
          createdAt: new Date().toISOString(),
          artworkId: artwork.id,
          location,
          client: clientMeta,
          detail: 'La imagen se genero, pero no se pudo guardar para el dashboard.',
        });
        return res.status(500).json({
          error: 'La imagen se genero, pero no se pudo guardar para el dashboard. Proba nuevamente.',
        });
      }

      return res.json({ imageUrl, imageId, saved: true });
    } catch (error) {
      await safeAddEvent(store, {
        id: crypto.randomUUID(),
        type: 'generate_error',
        createdAt: new Date().toISOString(),
        artworkId: artwork.id,
        location,
        client: clientMeta,
        detail: cleanText(error?.message, 300),
      });

      console.error('Error en /api/generate:', error);
      return res.status(500).json({ error: error?.message || 'Error generando imagen' });
    }
  });

  app.post('/api/metrics/event', async (req, res) => {
    const type = cleanText(req.body?.type, 40);
    if (!ALLOWED_EVENTS.has(type)) {
      return res.status(204).end();
    }

    const client = sanitizeClientMeta(req.body?.clientMeta);
    await safeAddEvent(store, {
      id: crypto.randomUUID(),
      type,
      createdAt: new Date().toISOString(),
      path: cleanText(req.body?.path, 160) || null,
      referrerDomain: referrerDomain(req.body?.referrer),
      artworkId: cleanText(req.body?.artworkId, 80) || null,
      location: buildApproxLocation(req, client),
      client,
    });

    return res.json({ ok: true });
  });

  app.post('/api/admin/login', (req, res) => {
    if (!loginLimiter.check(req)) {
      return res.status(429).json({ error: 'Demasiados intentos. Proba nuevamente en unos minutos.' });
    }

    const result = authenticateAdmin(req.body?.username, req.body?.password);
    if (!result.ok) {
      return res.status(result.status || 401).json({ error: result.error });
    }

    loginLimiter.reset(req);
    return res.json({
      token: result.token,
      expiresAt: result.expiresAt,
      localDefaults: result.localDefaults,
    });
  });

  app.get('/api/admin/dashboard', requireAdmin, async (_req, res) => {
    try {
      const dashboard = await store.getDashboard();
      return res.json(dashboard);
    } catch (error) {
      console.error('Error en /api/admin/dashboard:', error);
      return res.status(500).json({ error: 'No se pudo cargar el dashboard.' });
    }
  });

  app.get('/api/admin/image/:id', requireAdmin, async (req, res) => {
    try {
      const image = await store.getImage(req.params.id);
      if (!image) return res.status(404).json({ error: 'Imagen no encontrada.' });

      res.setHeader('Content-Type', image.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.send(image.buffer);
    } catch (error) {
      console.error('Error en /api/admin/image:', error);
      return res.status(500).json({ error: 'No se pudo cargar la imagen.' });
    }
  });

  if (serveStatic) {
    const publicDir = path.join(__dirname, 'public');
    app.use(express.static(publicDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  return app;
}

module.exports = { createApp };
