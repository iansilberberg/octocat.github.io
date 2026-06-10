const crypto = require('node:crypto');

const DEFAULT_SESSION_HOURS = 12;

function isLocalDev() {
  const isHostedFunction = Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
  return !isHostedFunction && process.env.NODE_ENV !== 'production';
}

function getSessionTtlMs() {
  const hours = Number(process.env.ADMIN_SESSION_HOURS || DEFAULT_SESSION_HOURS);
  return Math.max(1, Math.min(hours || DEFAULT_SESSION_HOURS, 24)) * 60 * 60 * 1000;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(unsigned, secret) {
  return crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
}

function readAdminConfig() {
  const useLocalDefaults = isLocalDev() && (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD);
  const username = process.env.ADMIN_USER || (useLocalDefaults ? 'admin' : '');
  const password = process.env.ADMIN_PASSWORD || (useLocalDefaults ? 'admin' : '');
  const secret = process.env.ADMIN_SECRET || password;

  return {
    username,
    password,
    secret,
    configured: Boolean(username && password && secret),
    useLocalDefaults,
  };
}

function getAdminStatus() {
  const config = readAdminConfig();
  return {
    configured: config.configured,
    localDefaults: config.useLocalDefaults,
  };
}

function authenticateAdmin(username, password) {
  const config = readAdminConfig();
  if (!config.configured) {
    return { ok: false, status: 503, error: 'El acceso admin no esta configurado.' };
  }

  if (!safeEqual(username, config.username) || !safeEqual(password, config.password)) {
    return { ok: false, status: 401, error: 'Usuario o contrasena incorrectos.' };
  }

  const issuedAt = Date.now();
  const expiresAt = issuedAt + getSessionTtlMs();
  const payload = {
    sub: config.username,
    iat: issuedAt,
    exp: expiresAt,
  };
  const unsigned = base64urlJson(payload);
  const token = `${unsigned}.${sign(unsigned, config.secret)}`;

  return {
    ok: true,
    token,
    expiresAt,
    localDefaults: config.useLocalDefaults,
  };
}

function verifyAdminToken(token) {
  const config = readAdminConfig();
  if (!config.configured) {
    return { ok: false, status: 503, error: 'El acceso admin no esta configurado.' };
  }

  const [payloadPart, signature] = String(token || '').split('.');
  if (!payloadPart || !signature) {
    return { ok: false, status: 401, error: 'Sesion invalida.' };
  }

  const expected = sign(payloadPart, config.secret);
  if (!safeEqual(signature, expected)) {
    return { ok: false, status: 401, error: 'Sesion invalida.' };
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (!payload?.exp || Date.now() > payload.exp) {
      return { ok: false, status: 401, error: 'Sesion vencida.' };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, status: 401, error: 'Sesion invalida.' };
  }
}

function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const auth = verifyAdminToken(match?.[1]);

  if (!auth.ok) {
    return res.status(auth.status || 401).json({ error: auth.error });
  }

  req.admin = auth.payload;
  return next();
}

module.exports = {
  authenticateAdmin,
  getAdminStatus,
  requireAdmin,
  verifyAdminToken,
};
