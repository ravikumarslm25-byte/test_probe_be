import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { Attempt, Room } from '../models/exam.js';
import { User, Student } from '../models/core.js';

/* ============================================================
   Live view transport.

   The design is deliberately two-tier, as the proposal states:

     · Every candidate uploads an interval capture to storage. That is
       the evidential record and it happens regardless of whether
       anyone is watching.

     · A candidate only streams at video frame rate while an
       invigilator has actually opened their tile. Streaming all 500
       candidates continuously would need a media server; streaming
       the one or two a proctor is looking at needs almost nothing.

   Frames relayed live are never written to disk. The evidence is the
   interval capture; the live view is for the person watching now.

   Frame relay rather than WebRTC is a deliberate choice: it needs no
   STUN or TURN, so it works from behind a college NAT with no extra
   infrastructure, and it cannot fail at ICE negotiation in front of a
   room of candidates. At 5 frames a second it reads as video.
   ============================================================ */

/* Two live profiles, plus off.

   GRID is what an invigilator sees across every tile at once — the
   whole room moving, the way a video call looks. Small and heavily
   compressed, because thirty of them arrive at the same time.

   FOCUS is the single candidate whose tile is open. Larger and
   smoother, because that is the one being scrutinised.

   Per candidate, GRID costs about 12 KB/s up. Thirty of them is
   roughly 2.9 Mbps down for the invigilator, which a campus network
   carries without difficulty. */
const PROFILES = {
  off:   { fps: 0,   width: 0,   quality: 0    },
  grid:  { fps: 1.5, width: 240, quality: 0.45 },   // floor, used when a room is full
  focus: { fps: 8,   width: 480, quality: 0.6  },
};

/* The grid rate adapts to how many candidates are actually streaming
   in the room. One candidate can afford 8 fps at 320px; thirty
   cannot, and drop to the floor. The invigilator's bandwidth stays
   roughly constant either way — about 3 Mbps for the whole wall. */
const gridProfile = (streamingInRoom) => {
  const n = Math.max(1, streamingInRoom);
  const fps = Math.max(PROFILES.grid.fps, Math.min(8, Math.round(24 / n)));
  return {
    fps,
    width: fps >= 6 ? 320 : fps >= 3 ? 280 : 240,
    quality: fps >= 6 ? 0.55 : 0.45,
  };
};

/* The focused candidate's rate is chosen by the invigilator, so the
   trade-off between smoothness and bandwidth is visible rather than
   hard-coded. 24 fps at 640px is roughly 4–5 Mbps for that one
   candidate, which is fine for one and unworkable for thirty — which
   is exactly why the grid stays at 1.5. */
const focusProfile = (fps) => {
  const f = Math.max(1, Math.min(24, Number(fps) || PROFILES.focus.fps));
  return {
    fps: f,
    width: f >= 16 ? 640 : f >= 10 ? 560 : 480,
    quality: f >= 16 ? 0.5 : 0.6,
  };
};

/* attemptId -> { socket, roomId, focusWatchers, student }
   Grid membership is NOT duplicated here: it is derived from the
   monitors map at the moment it is needed. */
const candidates = new Map();
/* roomId -> Set<socket> of invigilator sockets */
const monitors = new Map();

/* Every join decision is logged. Three rounds were spent guessing why
   a candidate never appeared online; the server should simply say. */
const log = (...a) => console.log('[ws]', ...a);

const send = (socket, payload) => {
  if (socket.readyState === 1) {
    try { socket.send(JSON.stringify(payload)); } catch { /* closing */ }
  }
};

async function authenticate(token) {
  let claims;
  try { claims = jwt.verify(token, env.accessSecret); } catch { return null; }

  if (claims.kind === 'student') {
    const s = await Student.findById(claims.sub).select('name regNo institutionId status').lean();
    if (!s || s.status !== 'active') return null;
    return { kind: 'student', id: String(s._id), name: s.name, regNo: s.regNo,
             institutionId: String(s.institutionId) };
  }

  const u = await User.findById(claims.sub).populate('roleIds', 'permissions scope')
    .select('name institutionId status roleIds').lean();
  if (!u || u.status !== 'active') return null;

  const permissions = new Set((u.roleIds || []).flatMap((r) => r.permissions || []));
  if (!permissions.has('invigilation:view')) return null;

  const rank = { own: 0, department: 1, institution: 2 };
  const scope = (u.roleIds || []).reduce((best, r) => (rank[r.scope] > rank[best] ? r.scope : best), 'own');

  return { kind: 'staff', id: String(u._id), name: u.name,
           institutionId: String(u.institutionId), permissions, scope };
}

/* Tells a candidate which profile to send at. Called whenever the set
   of watchers changes, so a candidate streams at grid rate while the
   room is open, steps up when their own tile is focused, and stops
   entirely once the last invigilator leaves. */
const roomWatchers = (roomId) => monitors.get(roomId) || new Set();

function retune(attemptId) {
  const entry = candidates.get(attemptId);
  if (!entry) return;

  const grid = roomWatchers(entry.roomId).size;
  const name = entry.focusWatchers.size > 0 ? 'focus'
    : grid > 0 ? 'grid'
    : 'off';

  const inRoom = [...candidates.values()].filter((e) => e.roomId === entry.roomId).length;
  const settings = name === 'focus' ? focusProfile(entry.focusFps)
    : name === 'grid' ? gridProfile(inRoom)
    : PROFILES[name];
  const signature = `${name}:${settings.fps}`;
  if (entry.signature === signature) return;   // nothing changed, stay quiet
  entry.profile = name;
  entry.signature = signature;

  log(`tune · ${entry.student?.regNo} · ${name} @ ${settings.fps}fps`
    + ` · room watchers ${grid} · focus watchers ${entry.focusWatchers.size}`);

  send(entry.socket, {
    type: 'tune',
    profile: name,
    ...settings,
    watchers: grid + entry.focusWatchers.size,
    focused: entry.focusWatchers.size > 0,
  });
}

/* Which rooms currently hold a connected candidate. Broadcast to every
   invigilator so the wall can say where the live people are, rather
   than leaving someone staring at the wrong tab. Every room in a
   seeded institution is called "Room 1", so the tabs are otherwise
   indistinguishable. */
function presenceMap() {
  const rooms = {};
  for (const e of candidates.values()) {
    if (!e.roomId) continue;
    rooms[e.roomId] = (rooms[e.roomId] || 0) + 1;
  }
  return rooms;
}

function broadcastPresence() {
  const rooms = presenceMap();
  const payload = JSON.stringify({ type: 'presence', rooms, total: candidates.size });
  for (const set of monitors.values()) {
    for (const s of set) {
      if (s.readyState === 1) { try { s.send(payload); } catch { /* closing */ } }
    }
  }
}

/* Every candidate in the room streams to this invigilator at grid
   rate. This is what makes the wall move rather than showing stills. */
function retuneRoom(roomId) {
  for (const [attemptId, entry] of candidates) {
    if (entry.roomId === roomId) retune(attemptId);
  }
}

function dropMonitor(socket) {
  const touched = new Set();
  for (const [roomId, set] of monitors) {
    if (set.delete(socket)) {
      touched.add(roomId);
      if (set.size === 0) monitors.delete(roomId);
    }
  }
  for (const [attemptId, entry] of candidates) {
    if (entry.rtcPeer === socket) {
      send(entry.socket, { type: 'rtc-close' });
      entry.rtcPeer = null;
    }
    if (entry.focusWatchers.delete(socket)) retune(attemptId);
  }
  for (const roomId of touched) retuneRoom(roomId);
}

export function attachRealtime(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket) => {
    socket.actor = null;
    socket.attemptId = null;
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    /* Authentication arrives as the first message rather than in a
       header, because a browser WebSocket cannot set headers, and a
       token in the query string ends up in access logs. */
    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'auth') {
        const actor = await authenticate(msg.token);
        if (!actor) { send(socket, { type: 'error', error: 'Not authorised' }); socket.close(4001); return; }
        socket.actor = actor;
        send(socket, { type: 'ready', kind: actor.kind });
        return;
      }

      if (!socket.actor) { send(socket, { type: 'error', error: 'Authenticate first' }); return; }

      /* A message meant for the other role is a symptom worth naming,
         not something to drop quietly. */
      const STUDENT_ONLY = ['attach', 'frame', 'audio', 'rtc-answer'];
      const STAFF_ONLY = ['watch-room', 'watch', 'unwatch', 'talk', 'rtc-offer', 'rtc-close'];

      if (socket.actor.kind === 'staff' && STUDENT_ONLY.includes(msg.type)) {
        log(`MISMATCH · "${msg.type}" arrived on a STAFF socket (${socket.actor.name}).`
          + ' The candidate tab is signed in as staff.');
        send(socket, {
          type: 'error',
          error: 'This browser tab is signed in as staff, not as the candidate. Sign out and sign in as the candidate.',
        });
        return;
      }
      if (socket.actor.kind === 'student' && STAFF_ONLY.includes(msg.type)) {
        log(`MISMATCH · "${msg.type}" arrived on a STUDENT socket (${socket.actor.regNo}).`);
        send(socket, {
          type: 'error',
          error: 'This browser tab is signed in as a candidate, not as staff.',
        });
        return;
      }

      /* ---------------- candidate ---------------- */
      if (socket.actor.kind === 'student') {
        if (msg.type === 'attach') {
          if (!msg.attemptId) {
            log(`attach REFUSED · ${socket.actor.regNo} · no attemptId sent`);
            send(socket, { type: 'error', error: 'No attempt was named' });
            return;
          }

          let attempt = null;
          try {
            attempt = await Attempt.findOne({
              _id: msg.attemptId, studentId: socket.actor.id,
              institutionId: socket.actor.institutionId,
            }).select('roomId status').lean();
          } catch (e) {
            log(`attach REFUSED · ${socket.actor.regNo} · bad id "${msg.attemptId}" · ${e.message}`);
            send(socket, { type: 'error', error: 'That examination reference is not valid' });
            return;
          }

          if (!attempt) {
            /* Distinguish "no such attempt" from "not yours", because
               the two have completely different causes. */
            const any = await Attempt.findById(msg.attemptId).select('studentId institutionId').lean().catch(() => null);
            const why = !any ? 'no attempt with that id'
              : String(any.studentId) !== socket.actor.id ? 'attempt belongs to another candidate'
              : 'attempt is in another institution';
            log(`attach REFUSED · ${socket.actor.regNo} · ${msg.attemptId} · ${why}`);
            send(socket, { type: 'error', error: `Live view unavailable: ${why}` });
            return;
          }

          socket.attemptId = String(attempt._id);
          const existing = candidates.get(socket.attemptId);
          if (existing && existing.socket !== socket) existing.socket.close(4002);

          const roomId = String(attempt.roomId || '');

          candidates.set(socket.attemptId, {
            socket,
            roomId,
            profile: null,
            signature: null,
            focusFps: PROFILES.focus.fps,
            focusWatchers: existing?.focusWatchers || new Set(),
            // a socket reconnect mid-handshake must not orphan the answer
            rtcPeer: existing?.rtcPeer || null,
            student: { name: socket.actor.name, regNo: socket.actor.regNo },
          });

          retune(socket.attemptId);

          log(`attach OK · ${socket.actor.regNo} · attempt ${socket.attemptId} · room ${roomId || 'NONE'}`
            + ` · ${(monitors.get(roomId) || new Set()).size} monitor(s) already watching`);

          broadcastPresence();

          send(socket, {
            type: 'attached',
            attemptId: socket.attemptId,
            roomId,
            monitors: (monitors.get(roomId) || new Set()).size,
          });

          if (!roomId) {
            send(socket, { type: 'error', error: 'This attempt has no room, so no invigilator can be assigned to it' });
          }

          // let anyone already watching the room know this candidate is live
          for (const m of monitors.get(roomId) || []) {
            send(m, { type: 'candidate-online', attemptId: socket.attemptId });
          }
          return;
        }

        /* Candidate audio goes only to invigilators who have the tile
           open, because listening is a deliberate act, not something
           that happens across thirty people at once. */
        /* Candidate half of the handshake, routed back to whichever
           invigilator opened the connection. */
        if ((msg.type === 'rtc-answer' || msg.type === 'rtc-ice') && socket.attemptId) {
          const entry = candidates.get(socket.attemptId);
          const peer = entry?.rtcPeer;
          if (!peer || peer.readyState !== 1) return;
          send(peer, {
            type: msg.type,
            attemptId: socket.attemptId,
            sdp: msg.sdp,
            candidate: msg.candidate,
          });
          if (msg.type === 'rtc-answer') log(`rtc answer · ${socket.actor.regNo} → invigilator`);
          return;
        }

        if (msg.type === 'audio' && socket.attemptId) {
          const entry = candidates.get(socket.attemptId);
          if (!entry || entry.focusWatchers.size === 0) return;
          const payload = JSON.stringify({
            type: 'audio', attemptId: socket.attemptId, data: msg.data, rate: msg.rate,
          });
          for (const w of entry.focusWatchers) {
            if (w.readyState === 1) { try { w.send(payload); } catch { /* closing */ } }
          }
          return;
        }

        if (msg.type === 'chat' && socket.attemptId) {
          const entry = candidates.get(socket.attemptId);
          if (!entry) return;
          const payload = JSON.stringify({
            type: 'chat', attemptId: socket.attemptId, from: 'student',
            body: msg.body, at: Date.now(),
          });
          for (const w of new Set([...roomWatchers(entry.roomId), ...entry.focusWatchers])) {
            if (w.readyState === 1) { try { w.send(payload); } catch { /* closing */ } }
          }
          return;
        }

        if (msg.type === 'frame' && socket.attemptId) {
          const entry = candidates.get(socket.attemptId);
          if (!entry) return;

          const watchers = new Set([...roomWatchers(entry.roomId), ...entry.focusWatchers]);
          if (watchers.size === 0) return;   // nobody watching, discard

          const payload = JSON.stringify({
            type: 'frame',
            attemptId: socket.attemptId,
            data: msg.data,
            focused: entry.focusWatchers.size > 0,
            at: Date.now(),
          });
          for (const w of watchers) {
            if (w.readyState === 1) { try { w.send(payload); } catch { /* closing */ } }
          }
          return;
        }

        log(`unhandled "${msg.type}" from candidate ${socket.actor.regNo}`);
        return;
      }

      /* ---------------- invigilator ---------------- */
      if (msg.type === 'watch-room') {
        const wide = socket.actor.permissions.has('exam:publish') || socket.actor.scope === 'institution';
        const filter = { _id: msg.roomId, institutionId: socket.actor.institutionId };
        if (!wide) filter.invigilatorId = socket.actor.id;

        const room = await Room.findOne(filter).select('_id name').lean().catch(() => null);
        if (!room) {
          log(`watch-room REFUSED · ${socket.actor.name} · room ${msg.roomId} · ${wide ? 'no such room in this institution' : 'not allocated to you'}`);
          send(socket, { type: 'error', error: 'That room is not allocated to you' });
          return;
        }

        dropMonitor(socket);
        const key = String(room._id);
        monitors.set(key, (monitors.get(key) || new Set()).add(socket));
        socket.roomId = key;

        retuneRoom(key);

        const inRoom = [...candidates.values()].filter((e) => e.roomId === key).length;
        log(`watch-room OK · ${socket.actor.name} · ${room.name} (${key}) · ${inRoom} candidate(s) online`
          + (inRoom === 0 && candidates.size > 0
            ? ` · WARNING: ${candidates.size} candidate(s) online in other rooms: ${[...new Set([...candidates.values()].map((e) => e.roomId))].join(', ')}`
            : ''));

        send(socket, {
          type: 'presence',
          rooms: presenceMap(),
          total: candidates.size,
        });

        send(socket, {
          type: 'room-state',
          roomId: key,
          gridProfile: PROFILES.grid,
          online: [...candidates.entries()]
            .filter(([, e]) => e.roomId === key)
            .map(([attemptId, e]) => ({ attemptId, student: e.student })),
        });
        return;
      }

      /* Opening a tile is what starts the candidate streaming. */
      if (msg.type === 'watch') {
        const entry = candidates.get(msg.attemptId);
        if (!entry) {
          log(`watch · ${socket.actor.name} · attempt ${msg.attemptId} is not connected`
            + ` · online now: [${[...candidates.keys()].join(', ') || 'none'}]`);
          send(socket, { type: 'offline', attemptId: msg.attemptId });
          return;
        }
        /* A coordinator with institution scope may open any candidate
           they can already see. Restricting to the currently selected
           room tab only produced silent failures. */
        const wideWatch = socket.actor.permissions.has('exam:publish')
          || socket.actor.scope === 'institution';
        if (!wideWatch && socket.roomId && entry.roomId !== socket.roomId) {
          log(`watch REFUSED · ${socket.actor.name} · candidate is in room ${entry.roomId}, watching ${socket.roomId}`);
          send(socket, { type: 'error', error: 'That candidate is not in a room allocated to you' });
          return;
        }
        entry.focusWatchers.add(socket);
        if (msg.fps) entry.focusFps = msg.fps;
        retune(msg.attemptId);
        send(socket, { type: 'watching', attemptId: msg.attemptId, ...focusProfile(entry.focusFps) });
        return;
      }

      /* ---- WebRTC signalling ----
         The socket only carries the handshake. Once it completes the
         media travels peer to peer, which is what gives real video and
         duplex audio rather than a stream of stills. */
      if (msg.type === 'rtc-offer') {
        const entry = candidates.get(msg.attemptId);
        if (!entry) { send(socket, { type: 'rtc-unavailable', attemptId: msg.attemptId }); return; }
        entry.rtcPeer = socket;
        log(`rtc offer · ${socket.actor.name} → ${entry.student?.regNo}`);
        send(entry.socket, { type: 'rtc-offer', sdp: msg.sdp });
        return;
      }
      if (msg.type === 'rtc-ice') {
        const entry = candidates.get(msg.attemptId);
        if (entry) send(entry.socket, { type: 'rtc-ice', candidate: msg.candidate });
        return;
      }
      if (msg.type === 'rtc-close') {
        const entry = candidates.get(msg.attemptId);
        if (entry) { send(entry.socket, { type: 'rtc-close' }); entry.rtcPeer = null; }
        return;
      }

      /* Invigilator talk-back. Relayed only to the named candidate. */
      if (msg.type === 'talk') {
        const entry = candidates.get(msg.attemptId);
        if (!entry) return;
        if (!entry.focusWatchers.has(socket)) return;   // must have the tile open
        send(entry.socket, { type: 'audio-down', data: msg.data, rate: msg.rate });
        return;
      }

      if (msg.type === 'chat') {
        const entry = candidates.get(msg.attemptId);
        if (entry) {
          send(entry.socket, {
            type: 'chat', from: 'invigilator', body: msg.body, at: Date.now(),
          });
        }
        // echo to every invigilator on the room so a second proctor sees it
        for (const m of monitors.get(socket.roomId) || []) {
          if (m !== socket) {
            send(m, { type: 'chat', attemptId: msg.attemptId, from: 'invigilator',
                      body: msg.body, at: Date.now() });
          }
        }
        return;
      }

      if (msg.type === 'unwatch') {
        const entry = candidates.get(msg.attemptId);
        if (entry) {
          entry.focusWatchers.delete(socket);
          if (entry.rtcPeer === socket) { send(entry.socket, { type: 'rtc-close' }); entry.rtcPeer = null; }
          retune(msg.attemptId);
        }
        return;
      }

      log(`unhandled "${msg.type}" from ${socket.actor.kind} ${socket.actor.name || socket.actor.regNo}`);
    });

    socket.on('close', () => {
      if (socket.actor?.kind === 'student' && socket.attemptId) {
        const entry = candidates.get(socket.attemptId);
        if (entry?.socket === socket) {
          for (const w of new Set([...roomWatchers(entry.roomId), ...entry.focusWatchers])) {
            send(w, { type: 'offline', attemptId: socket.attemptId });
          }
          candidates.delete(socket.attemptId);
          broadcastPresence();
        }
      } else {
        dropMonitor(socket);
      }
    });

    socket.on('error', () => { /* close handler does the cleanup */ });
  });

  /* A candidate whose laptop sleeps leaves a socket that looks open.
     The heartbeat is what makes "disconnected" appear on the wall. */
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) { socket.terminate(); continue; }
      socket.isAlive = false;
      try { socket.ping(); } catch { /* terminating */ }
    }
  }, 20000);

  wss.on('close', () => clearInterval(heartbeat));

  console.log('[ws] live view relay on /ws');
  return wss;
}

/* ============================================================
   Push helpers for the REST routes.

   A microphone grant, a warning and a termination are all authored
   through REST so they are audited, but the candidate should feel
   them immediately rather than on the next heartbeat.
   ============================================================ */
export function pushToCandidate(attemptId, payload) {
  const entry = candidates.get(String(attemptId));
  if (!entry) return false;
  send(entry.socket, payload);
  return true;
}

export function pushToWatchers(attemptId, payload) {
  const entry = candidates.get(String(attemptId));
  if (!entry) return 0;
  const all = new Set([...roomWatchers(entry.roomId), ...entry.focusWatchers]);
  for (const w of all) send(w, payload);
  return all.size;
}

export function pushToRoom(roomId, payload) {
  const set = monitors.get(String(roomId)) || new Set();
  for (const s of set) send(s, payload);
  return set.size;
}

export const liveStats = () => ({
  candidatesOnline: candidates.size,
  monitors: [...monitors.values()].reduce((n, s) => n + s.size, 0),
  streamingGrid: [...candidates.values()].filter((e) => e.profile === 'grid').length,
  streamingFocus: [...candidates.values()].filter((e) => e.profile === 'focus').length,
});

export { PROFILES };
