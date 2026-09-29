import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/* The server folder, found from this file rather than from the current
   directory, so a process manager can start the API from anywhere and
   it still finds its .env and its uploads folder. */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const need = (k, fallback) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${k}`);
  return v;
};


/* PUBLIC_URL is ONE address — where a browser reaches this API — and
   it is what every proctoring capture is linked from. CORS_ORIGINS
   beside it in the same file is a comma-separated list, and the two
   get confused: a PUBLIC_URL of "https://api.example.com,http://localhost:5050"
   produced evidence links with both hosts glued together, so every
   capture in the timeline showed as a broken image. Take the first
   address, drop anything after it, and complain loudly at boot. */
function publicUrl() {
  const raw = process.env.PUBLIC_URL;
  const fallback = `http://localhost:${Number(process.env.PORT || 5050)}`;
  if (!raw || !raw.trim()) return fallback;

  const first = raw.split(',')[0].trim().replace(/\/+$/, '');
  if (first !== raw.trim().replace(/\/+$/, '')) {
    console.warn(`[env] PUBLIC_URL holds more than one address. Using "${first}".`);
    console.warn('      PUBLIC_URL is a single address; CORS_ORIGINS is the list.');
  }

  try {
    const u = new URL(first);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol');
  } catch {
    console.warn(`[env] PUBLIC_URL "${first}" is not a valid address. Using ${fallback}.`);
    console.warn('      Proctoring captures will not load until this is corrected.');
    return fallback;
  }
  return first;
}

export const env = {
  nodeEnv:  process.env.NODE_ENV || 'development',
  port:     Number(process.env.PORT || 5050),
  mongoUri: need('MONGO_URI', 'mongodb://127.0.0.1:27017/testprobe'),
  accessSecret:  need('JWT_ACCESS_SECRET', 'dev-access-secret'),
  refreshSecret: need('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
  accessTtl:  process.env.ACCESS_TTL  || '15m',
  refreshTtl: process.env.REFRESH_TTL || '7d',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim()),

  /* Where this API is reachable from a browser. Evidence stored on the
     local driver is served from here, so the URL has to be absolute —
     a relative path would resolve against the web app's origin, not
     the API's. */
  publicUrl: publicUrl(),

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
