import mongoose from 'mongoose';
import { env, isProd } from './env.js';

/* Atlas fails differently from a local mongod: it hangs on a blocked
   IP rather than refusing the connection, and it silently uses the
   "test" database when the URI has no database name. Both are caught
   here with an explanation rather than a stack trace. */

function inspectUri(uri) {
  const notes = [];
  const isSrv = uri.startsWith('mongodb+srv://');

  // database name sits between the last / and any ?
  const afterHost = uri.split('/').slice(isSrv ? 3 : 3).join('/');
  const dbName = afterHost.split('?')[0];
  if (!dbName) {
    notes.push('No database name in the connection string, so Mongo is using "test".');
    notes.push('Add /examprobe before the ? to name it — but note that anything already');
    notes.push('seeded went into "test", so you would need to run the seed again afterwards.');
  }

  const creds = uri.match(/\/\/([^:]+):([^@]+)@/);
  if (creds && /[@/:?#[\]]/.test(decodeURIComponent(creds[2])) && creds[2] === decodeURIComponent(creds[2])) {
    notes.push('The password contains a character that must be percent-encoded (@ : / ? # [ ]). Encode it or Atlas will reject the string.');
  }

  return { isSrv, dbName: dbName || 'test', notes };
}

/* The driver says "whitelist your IP" without saying which one, which
   means a detour to find out. Ask a public echo service, briefly, and
   only when that is the error being reported. */
async function publicIp() {
  try {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), 2500);
    const r = await fetch('https://api.ipify.org?format=json', { signal: c.signal });
    clearTimeout(timer);
    const d = await r.json();
    return d.ip || null;
  } catch { return null; }
}

function explain(e) {
  const m = e?.message || '';

  if (/socket has been ended|EPIPE|ECONNRESET|socket hang up/i.test(m)) {
    return [
      'The TLS handshake was cut off part way through. The address resolved, so',
      'this is not a wrong hostname. In order of likelihood:',
      '',
      '  1. The cluster is paused or resuming. Atlas pauses a free cluster after',
      '     about 60 days idle, and also briefly drops connections while resuming.',
      '     Open the Atlas dashboard — if it says Paused, click Resume and wait a',
      '     minute.',
      '  2. Something on the network is terminating the connection: a VPN, a',
      '     corporate proxy, or antivirus doing TLS inspection. Try disconnecting',
      '     the VPN, or switch to a different network or a phone hotspot.',
      '  3. The cluster is mid-maintenance or scaling. This clears by itself.',
      '',
      'This is usually transient, which is why the connection is retried below.',
    ];
  }
  if (/IP that isn't whitelisted|whitelist|ReplicaSetNoPrimary/i.test(m)) {
    return [
      'Atlas refused the connection. The hostnames resolved, so the cluster',
      'exists and the connection string is right — nothing reachable answered.',
      '',
      '  1. Your IP is not on the Network Access list. Atlas → Network Access →',
      '     Add IP Address → Add Current IP Address, and wait for it to turn Active.',
      '     Moving between networks changes your IP, so an entry added earlier today',
      '     may already be stale.',
      '  2. The cluster is paused. Atlas → Database → Clusters → Resume.',
      '  3. A VPN or a network that blocks outbound 27017.',
    ];
  }
  if (/ETIMEDOUT|ENOTFOUND|querySrv/i.test(m)) {
    return [
      'The cluster host could not be reached. Usually one of:',
      '  · your IP is not on the Atlas Network Access list — add it, or 0.0.0.0/0 while testing',
      '  · the cluster is paused',
      '  · the SRV hostname is mistyped',
    ];
  }
  if (/authentication failed|bad auth/i.test(m)) {
    return [
      'Atlas rejected the credentials. Check the database user and password, and',
      'remember that a special character in the password must be percent-encoded',
      '(@ becomes %40, / becomes %2F, and so on).',
    ];
  }
  if (/ECONNREFUSED/i.test(m)) {
    return ['Nothing is listening at that address. If you meant a local server, start mongod first.'];
  }
  if (/Server selection timed out/i.test(m)) {
    return [
      'No cluster member answered in time. Check the Network Access list, and',
      'whether the cluster is paused.',
    ];
  }
  return null;
}

/* A dropped handshake is common against Atlas and almost always
   transient, so the first attempt is not treated as fatal. An exam
   platform should not need a manual restart because one TLS
   negotiation was cut short. */
export async function connectDb({ quiet = false, attempts = 4 } = {}) {
  const { isSrv, dbName, notes } = inspectUri(env.mongoUri);
  notes.forEach((n) => console.warn(`[db] ${n}`));

  mongoose.set('strictQuery', true);

  const options = {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    socketTimeoutMS: 45000,
    maxPoolSize: isProd ? 50 : 10,
    retryWrites: true,
    autoIndex: !isProd,
  };

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await mongoose.connect(env.mongoUri, options);
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      if (attempt < attempts) {
        const wait = attempt * 2000;
        console.warn(`[db] attempt ${attempt} of ${attempts} failed (${e.message}). Retrying in ${wait / 1000}s…`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  if (lastError) {
    console.error(`\n[db] could not connect after ${attempts} attempts\n`);
    const help = explain(lastError);
    if (help) help.forEach((l) => console.error(l ? `  ${l}` : ''));

    if (/whitelist|ReplicaSetNoPrimary/i.test(lastError.message)) {
      const ip = await publicIp();
      if (ip) console.error(`\n  This machine's public address is ${ip} — add exactly that.`);
    }

    console.error(`\n  Driver said: ${lastError.message}\n`);
    throw lastError;
  }

  /* Mongoose reconnects on its own once a connection has been made.
     These are logged so a drop during an examination is visible in the
     server output rather than only in a candidate's browser. */
  mongoose.connection.on('disconnected', () => console.warn('[db] disconnected — reconnecting'));
  mongoose.connection.on('reconnected', () => console.log('[db] reconnected'));
  mongoose.connection.on('error', (e) => console.error('[db] error:', e.message));

  if (!quiet) {
    const host = isSrv ? env.mongoUri.split('@')[1]?.split('/')[0] : env.mongoUri.split('/')[2];
    console.log(`[db] connected → ${host} · database "${dbName}"`);
  }
  return mongoose.connection;
}

/* Used by `npm run check-db` so the connection can be proved
   before anyone runs a seed that wipes data. */
export async function checkDb() {
  const conn = await connectDb();
  const admin = conn.db.admin();
  const info = await admin.serverStatus().catch(() => null);
  const collections = await conn.db.listCollections().toArray();

  console.log(`[db] server version ${info?.version || 'unknown'}`);
  console.log(`[db] ${collections.length} existing collection(s)`);
  if (collections.length) {
    for (const c of collections) {
      const n = await conn.db.collection(c.name).countDocuments();
      console.log(`       ${c.name.padEnd(16)} ${n} document(s)`);
    }
  }
  await mongoose.connection.close();
}
