import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

/* ============================================================
   Evidence storage.

   The proposal commits to S3 with lifecycle tiering, but the POC
   must run without AWS credentials. Both drivers satisfy the same
   contract, so switching is a single env var and no route changes.

   STORAGE_DRIVER=local  → server/uploads (default)
   STORAGE_DRIVER=s3     → needs AWS_* and S3_BUCKET
   ============================================================ */

const ROOT = path.resolve(process.cwd(), 'uploads');

const KIND_RULES = {
  face:     { max: 2_000_000,  types: ['image/jpeg', 'image/png', 'image/webp'] },
  id_card:  { max: 4_000_000,  types: ['image/jpeg', 'image/png', 'image/webp'] },
  frame:    { max: 1_500_000,  types: ['image/jpeg', 'image/webp'] },
  screen:   { max: 3_000_000,  types: ['image/jpeg', 'image/webp'] },
  scan:     { max: 8_000_000,  types: ['image/jpeg', 'image/png', 'image/webp'] },
  audio:    { max: 2_000_000,  types: ['audio/webm', 'audio/ogg', 'audio/mpeg'] },
};

export function validateUpload(kind, mime, bytes) {
  const rule = KIND_RULES[kind];
  if (!rule) return `Unknown evidence kind "${kind}"`;
  if (!rule.types.includes(mime)) return `${kind} must be one of ${rule.types.join(', ')}`;
  if (bytes > rule.max) return `${kind} exceeds ${Math.round(rule.max / 1024)}KB`;
  return null;
}

/* Keys are structured so a retention policy can target a whole
   attempt, and so an operator can find one candidate's evidence
   without a database lookup. */
export function evidenceKey({ institutionId, examId, attemptId, kind, ext = 'jpg' }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(4).toString('hex');
  return `${institutionId}/${examId}/${attemptId}/${kind}/${stamp}-${rand}.${ext}`;
}

/* ---------------- local disk ---------------- */
const localDriver = {
  name: 'local',
  async put(key, buffer) {
    const full = path.join(ROOT, key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
    return { key, url: this.urlFor(key) };
  },
  async get(key) {
    return fs.readFile(path.join(ROOT, key));
  },
  /* Absolute, because the browser loading this is served from the web
     app's origin, not the API's. The S3 driver returns absolute
     presigned URLs, so both drivers honour the same contract: what
     comes back can be put straight into an <img src>. */
  urlFor(key) {
    return `${env.publicUrl}/uploads/${encodeURI(key)}`;
  },
  async remove(prefix) {
    const full = path.join(ROOT, prefix);
    await fs.rm(full, { recursive: true, force: true });
  },
};

/* ---------------- S3 ----------------
   Loaded lazily so the aws sdk is not a hard dependency of the
   local build. */
function s3Driver() {
  let client, PutObjectCommand, GetObjectCommand, getSignedUrl;
  const bucket = process.env.S3_BUCKET;

  const init = async () => {
    if (client) return;
    const s3 = await import('@aws-sdk/client-s3');
    const presign = await import('@aws-sdk/s3-request-presigner');
    PutObjectCommand = s3.PutObjectCommand;
    GetObjectCommand = s3.GetObjectCommand;
    getSignedUrl = presign.getSignedUrl;
    client = new s3.S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
  };

  return {
    name: 's3',
    async put(key, buffer, mime = 'image/jpeg') {
      await init();
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: buffer, ContentType: mime,
        ServerSideEncryption: 'AES256',
      }));
      return { key, url: await this.urlFor(key) };
    },
    async get(key) {
      await init();
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await r.Body.transformToByteArray());
    },
    async urlFor(key) {
      await init();
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 900 });
    },
    async remove() {
      // lifecycle policy handles expiry on S3; nothing to do here
    },
  };
}

export const storage = process.env.STORAGE_DRIVER === 's3' ? s3Driver() : localDriver;

export const storageRoot = ROOT;

/* Accepts a data URL from the browser and returns buffer + mime.
   The candidate portal captures frames to canvas, so data URLs are
   the natural transport and avoid a multipart parser. */
export function decodeDataUrl(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
}
