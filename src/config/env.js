import dotenv from 'dotenv';
dotenv.config();

const need = (k, fallback) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${k}`);
  return v;
};

export const env = {
  nodeEnv:  process.env.NODE_ENV || 'development',
  port:     Number(process.env.PORT || 5050),
  mongoUri: need('MONGO_URI', 'mongodb://127.0.0.1:27017/examgenix'),
  accessSecret:  need('JWT_ACCESS_SECRET', 'dev-access-secret'),
  refreshSecret: need('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
  accessTtl:  process.env.ACCESS_TTL  || '15m',
  refreshTtl: process.env.REFRESH_TTL || '7d',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim()),

  /* Where this API is reachable from a browser. Evidence stored on the
     local driver is served from here, so the URL has to be absolute —
     a relative path would resolve against the web app's origin, not
     the API's. */
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${Number(process.env.PORT || 5050)}`)
    .replace(/\/$/, ''),

  /* WebRTC. Public STUN is enough for a candidate and an invigilator on
     the same network, which covers a campus and covers testing. A TURN
     server is required once either side sits behind a symmetric NAT,
     which is the normal case over the open internet. */
  stunUrls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',').map((s) => s.trim()).filter(Boolean),
  turnUrl: process.env.TURN_URL || '',
  turnUsername: process.env.TURN_USERNAME || '',
  turnCredential: process.env.TURN_CREDENTIAL || '',
};

export const isProd = env.nodeEnv === 'production';
