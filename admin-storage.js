const fs = require('node:fs/promises');
const path = require('node:path');

const DB_VERSION = 1;
const DB_KEY = 'db.json';
const MAX_EVENTS = 8000;
const MAX_IMAGES = 2000;

function emptyDb() {
  return { version: DB_VERSION, images: [], events: [] };
}

function normalizeDb(db) {
  if (!db || typeof db !== 'object') return emptyDb();
  return {
    version: DB_VERSION,
    images: Array.isArray(db.images) ? db.images : [],
    events: Array.isArray(db.events) ? db.events : [],
  };
}

function cleanText(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanOptional(value, max = 120) {
  const text = cleanText(value, max);
  return text || null;
}

function decodeHeader(value) {
  if (!value) return null;
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

function header(req, names) {
  for (const name of names) {
    const value = req.get?.(name);
    if (value) return value;
  }
  return null;
}

function firstIp(value) {
  return String(value || '').split(',')[0].trim().replace(/^::ffff:/, '');
}

function maskIp(value) {
  const ip = firstIp(value).replace(/^\[/, '').replace(/\]$/, '');
  if (!ip) return null;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }

  if (ip.includes(':')) {
    return `${ip.split(':').slice(0, 4).join(':')}::`;
  }

  return null;
}

function parseMaybeJson(value) {
  if (!value) return {};
  const raw = decodeHeader(value);
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function detectDevice(req) {
  const ua = req.get?.('user-agent') || '';
  if (/ipad|tablet/i.test(ua)) return 'tablet';
  if (/mobile|android|iphone|ipod/i.test(ua)) return 'mobile';
  if (ua) return 'desktop';
  return null;
}

function sanitizeClientMeta(meta = {}) {
  const languages = Array.isArray(meta.languages)
    ? meta.languages.map((lang) => cleanText(lang, 32)).filter(Boolean).slice(0, 4)
    : [];

  return {
    timeZone: cleanOptional(meta.timeZone, 80),
    locale: cleanOptional(meta.locale, 40),
    languages,
    viewport: cleanOptional(meta.viewport, 32),
    screen: cleanOptional(meta.screen, 32),
    path: cleanOptional(meta.path, 160),
    referrerDomain: cleanOptional(meta.referrerDomain, 120),
  };
}

function buildApproxLocation(req, meta = {}) {
  const client = sanitizeClientMeta(meta);
  const nfGeo = parseMaybeJson(header(req, ['x-nf-geo', 'netlify-geo']));
  const ip = header(req, [
    'x-nf-client-connection-ip',
    'cf-connecting-ip',
    'x-real-ip',
    'x-forwarded-for',
  ]) || req.ip;

  const city = cleanOptional(
    decodeHeader(header(req, ['x-vercel-ip-city', 'x-nf-geo-city', 'cf-ipcity'])) ||
      nfGeo.city ||
      nfGeo?.location?.city,
    80
  );
  const region = cleanOptional(
    decodeHeader(header(req, ['x-vercel-ip-country-region', 'x-nf-geo-subdivision'])) ||
      nfGeo.subdivision ||
      nfGeo.region ||
      nfGeo?.location?.region,
    80
  );
  const countryCode = cleanOptional(
    header(req, ['x-vercel-ip-country', 'cf-ipcountry', 'x-country']) ||
      nfGeo.country?.code ||
      nfGeo.countryCode,
    12
  );
  const country = cleanOptional(nfGeo.country?.name || nfGeo.country || countryCode, 80);
  const timeZone = cleanOptional(
    header(req, ['x-vercel-ip-timezone']) || nfGeo.timezone || client.timeZone,
    80
  );
  const language = cleanOptional(
    client.locale || header(req, ['accept-language'])?.split(',')[0],
    40
  );

  return {
    city,
    region,
    country,
    countryCode,
    timeZone,
    language,
    ipMasked: maskIp(ip),
    device: detectDevice(req),
    source: city || region || country ? 'hosting' : timeZone ? 'browser' : 'unknown',
  };
}

function extensionForMime(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'png';
}

function parseDataUrl(dataUrl) {
  const match = /^data:(.+?);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  return { mimeType: match[1], b64: match[2] };
}

function bufferFromImageInput(input, fallbackMimeType = 'image/png') {
  if (Buffer.isBuffer(input)) {
    return { mimeType: fallbackMimeType, buffer: input };
  }

  if (input && Buffer.isBuffer(input.buffer)) {
    return {
      mimeType: input.mimeType || fallbackMimeType,
      buffer: input.buffer,
    };
  }

  if (input?.b64) {
    return {
      mimeType: input.mimeType || fallbackMimeType,
      buffer: Buffer.from(input.b64, 'base64'),
    };
  }

  const parsed = parseDataUrl(input);
  if (!parsed) return null;
  return {
    mimeType: parsed.mimeType || fallbackMimeType,
    buffer: Buffer.from(parsed.b64, 'base64'),
  };
}

function parseStoredBuffer(buffer, fallbackMimeType = 'image/png') {
  const prefix = buffer.slice(0, 64).toString('utf8');
  if (prefix.startsWith('data:')) {
    return bufferFromImageInput(buffer.toString('utf8'), fallbackMimeType);
  }
  return {
    mimeType: fallbackMimeType,
    buffer,
  };
}

function imageKey(id) {
  return `image-${id}`;
}

function legacyImageKey(id) {
  return `images/${id}`;
}

function readBlobsContext() {
  const encoded = process.env.NETLIFY_BLOBS_CONTEXT;
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFileDriver(dataDir) {
  const dbPath = path.join(dataDir, 'qti-admin.json');
  const imageDir = path.join(dataDir, 'generated-images');

  async function ensureDirs() {
    await fs.mkdir(imageDir, { recursive: true });
  }

  return {
    name: 'file',

    async readDb() {
      try {
        const raw = await fs.readFile(dbPath, 'utf8');
        return normalizeDb(JSON.parse(raw));
      } catch (error) {
        if (error.code === 'ENOENT') return emptyDb();
        throw error;
      }
    },

    async writeDb(db) {
      await ensureDirs();
      const tempPath = `${dbPath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(normalizeDb(db), null, 2));
      await fs.rename(tempPath, dbPath);
    },

    async writeImage(record, imageInput) {
      await ensureDirs();
      const image = bufferFromImageInput(imageInput, record.mimeType || 'image/png');
      if (!image) throw new Error('Formato de imagen invalido.');
      const filePath = path.join(imageDir, `${record.id}.${extensionForMime(image.mimeType)}`);
      await fs.writeFile(filePath, image.buffer);
    },

    async readImage(record) {
      const mimeType = record.mimeType || 'image/png';
      const filePath = path.join(imageDir, `${record.id}.${extensionForMime(mimeType)}`);
      return {
        mimeType,
        buffer: await fs.readFile(filePath),
      };
    },
  };
}

function createBlobDriver() {
  let storePromise = null;

  async function getStore() {
    if (!storePromise) {
      storePromise = import('@netlify/blobs').then(({ getStore: loadStore }) => {
        const context = readBlobsContext();
        if (context?.siteID && context?.token) {
          return loadStore({
            name: 'qti-admin',
            siteID: context.siteID,
            token: context.token,
            apiURL: process.env.NETLIFY_BLOBS_API_URL || 'https://api.netlify.com',
          });
        }
        return loadStore('qti-admin');
      });
    }
    return storePromise;
  }

  return {
    name: 'netlify-blobs',

    async readDb() {
      const store = await getStore();
      const db = await store.get(DB_KEY, { type: 'json' });
      return normalizeDb(db);
    },

    async writeDb(db) {
      const store = await getStore();
      await store.set(DB_KEY, JSON.stringify(normalizeDb(db)), {
        metadata: { contentType: 'application/json' },
      });
    },

    async writeImage(record, imageInput) {
      const store = await getStore();
      const image = bufferFromImageInput(imageInput, record.mimeType || 'image/png');
      if (!image) throw new Error('Formato de imagen invalido.');
      await store.setJSON(imageKey(record.id), {
        mimeType: image.mimeType,
        b64: image.buffer.toString('base64'),
      }, {
        metadata: {
          mimeType: image.mimeType,
          contentType: image.mimeType,
          createdAt: record.createdAt,
        },
      });
    },

    async readImage(record) {
      const store = await getStore();
      const stored = await store.get(imageKey(record.id), { type: 'json' }).catch(() => null);
      const image = bufferFromImageInput(stored, record.mimeType || 'image/png');
      if (image) {
        return {
          mimeType: image.mimeType,
          buffer: image.buffer,
        };
      }

      const legacyText = await store.get(legacyImageKey(record.id), { type: 'text' }).catch(() => null);
      const legacyFromText = bufferFromImageInput(legacyText, record.mimeType || 'image/png');
      if (legacyFromText) {
        return {
          mimeType: legacyFromText.mimeType,
          buffer: legacyFromText.buffer,
        };
      }

      const legacyBytes = await store.getWithMetadata(legacyImageKey(record.id), { type: 'arrayBuffer' }).catch(() => null);
      if (!legacyBytes?.data) return null;
      const mimeType = legacyBytes.metadata?.mimeType || record.mimeType || 'image/png';
      const legacyFromBytes = parseStoredBuffer(Buffer.from(legacyBytes.data), mimeType);
      if (!legacyFromBytes) return null;
      return {
        mimeType: legacyFromBytes.mimeType,
        buffer: legacyFromBytes.buffer,
      };
    },
  };
}

function shouldUseBlobs() {
  if (process.env.QTI_STORAGE_DRIVER === 'file') return false;
  if (process.env.QTI_STORAGE_DRIVER === 'blobs') return true;
  return Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function daysAgo(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function locationLabel(location = {}) {
  const parts = [location.city, location.region, location.country].filter(Boolean);
  if (parts.length) return parts.join(', ');
  if (location.timeZone) return location.timeZone;
  if (location.countryCode) return location.countryCode;
  return 'Sin dato';
}

function countBy(items, readLabel) {
  const counts = new Map();
  for (const item of items) {
    const label = readLabel(item) || 'Sin dato';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 8);
}

function summarizeDb(db, driverName) {
  const images = [...db.images].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const events = [...db.events].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const today = dateKey(new Date());
  const since7 = daysAgo(6);
  const since30 = daysAgo(29);

  const imageSince = (date) => images.filter((item) => new Date(item.createdAt) >= date).length;
  const eventType = (type) => events.filter((event) => event.type === type);
  const eventToday = (type) => eventType(type).filter((event) => dateKey(event.createdAt) === today).length;

  const daily = [];
  for (let i = 13; i >= 0; i -= 1) {
    const day = dateKey(daysAgo(i));
    daily.push({
      date: day,
      pageViews: eventType('page_view').filter((event) => dateKey(event.createdAt) === day).length,
      generations: images.filter((image) => dateKey(image.createdAt) === day).length,
      downloads: eventType('download_click').filter((event) => dateKey(event.createdAt) === day).length,
    });
  }

  return {
    storageDriver: driverName,
    metrics: {
      totalImages: images.length,
      generationsToday: images.filter((image) => dateKey(image.createdAt) === today).length,
      generations7d: imageSince(since7),
      generations30d: imageSince(since30),
      totalPageViews: eventType('page_view').length,
      pageViewsToday: eventToday('page_view'),
      totalDownloads: eventType('download_click').length,
      downloadsToday: eventToday('download_click'),
      totalErrors: eventType('generate_error').length,
      errorsToday: eventToday('generate_error'),
      daily,
      artworks: countBy(images, (image) => image.artworkTitle || image.artworkId),
      locations: countBy(images, (image) => locationLabel(image.location)),
      devices: countBy(images, (image) => image.location?.device),
    },
    images: images.slice(0, 200).map((image) => ({
      id: image.id,
      createdAt: image.createdAt,
      artworkId: image.artworkId,
      artworkTitle: image.artworkTitle,
      promptPreview: image.promptPreview,
      promptLength: image.promptLength,
      mimeType: image.mimeType,
      bytes: image.bytes,
      location: image.location,
      client: image.client,
    })),
  };
}

function createAdminStore(options = {}) {
  const dataDir = options.dataDir || process.env.QTI_DATA_DIR || path.join(process.cwd(), 'data');
  const driver = shouldUseBlobs() ? createBlobDriver() : createFileDriver(dataDir);

  return {
    driverName: driver.name,

    async addImage(record, imageInput) {
      const db = await driver.readDb();
      await driver.writeImage(record, imageInput);
      let savedImage = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        savedImage = await driver.readImage(record);
        if (savedImage?.buffer?.length) break;
        await delay(120 * (attempt + 1));
      }
      if (!savedImage?.buffer?.length) {
        throw new Error('La imagen no quedo disponible en la base.');
      }
      db.images = [record, ...db.images.filter((item) => item.id !== record.id)].slice(0, MAX_IMAGES);
      await driver.writeDb(db);
      return record;
    },

    async addEvent(event) {
      const db = await driver.readDb();
      db.events = [event, ...db.events].slice(0, MAX_EVENTS);
      await driver.writeDb(db);
      return event;
    },

    async getDashboard() {
      const db = await driver.readDb();
      return summarizeDb(db, driver.name);
    },

    async getImage(id) {
      const db = await driver.readDb();
      const record = db.images.find((image) => image.id === id);
      if (!record) return null;
      const image = await driver.readImage(record);
      return image ? { ...image, record } : null;
    },
  };
}

module.exports = {
  buildApproxLocation,
  createAdminStore,
  sanitizeClientMeta,
};
