/*
 * Followers / following, stored on the server (like Instagram).
 *
 * Before this, "following" lived only on the follower's phone, so the
 * person being followed never saw it, and every Followers list was empty.
 *
 * People are identified by a public id (session.publicId(email)) - never by
 * the editable @handle and never by email in anything sent to the app.
 *   people  : pid -> email, display name, @handle   (kept up to date by the
 *             server on sign-up / login / profile sync / publishing a reel)
 *   follows : follower pid -> followee pid
 *
 * Postgres when DATABASE_URL is set, in-memory otherwise (local testing).
 */
const session = require('./session-service');
const HAS_DB = !!process.env.DATABASE_URL;

let pool = null;
function getPool() {
  if (pool || !HAS_DB) return pool;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  return pool;
}

const memPeople = new Map();   // pid -> {pid,email,name,handle,last_active,show_active,allow_mentions}
const memFollows = [];         // {follower, followee, at}
const memNotes = [];
const memDevices = new Map();  // pid -> Set(deviceId)
const COMMENT_PERMS = ['Everyone', 'Followers', 'People I follow', 'Nobody'];           // {id,user_pid,type,from_pid,reel_id,text,created_at}
let memNoteId = 0;

async function initSchema() {
  if (!HAS_DB) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS people (
      pid        TEXT PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      name       TEXT,
      handle     TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS people_handle_idx ON people (lower(handle));
    CREATE TABLE IF NOT EXISTS follows (
      follower   TEXT NOT NULL,
      followee   TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (follower, followee)
    );
    CREATE INDEX IF NOT EXISTS follows_followee_idx ON follows (followee, created_at DESC);
    CREATE INDEX IF NOT EXISTS follows_follower_idx ON follows (follower, created_at DESC);
    -- Privacy settings + last time the person used the app.
    ALTER TABLE people ADD COLUMN IF NOT EXISTS last_active    TIMESTAMPTZ;
    ALTER TABLE people ADD COLUMN IF NOT EXISTS show_active    BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE people ADD COLUMN IF NOT EXISTS allow_mentions BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE people ADD COLUMN IF NOT EXISTS comment_permission TEXT NOT NULL DEFAULT 'Everyone';
    -- Phones each account has signed in on (for "new sign-in" alerts).
    CREATE TABLE IF NOT EXISTS login_devices (
      pid        TEXT NOT NULL,
      device_id  TEXT NOT NULL,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (pid, device_id)
    );
    -- In-app notifications delivered to OTHER people's phones.
    CREATE TABLE IF NOT EXISTS notifications (
      id         BIGSERIAL PRIMARY KEY,
      user_pid   TEXT NOT NULL,
      type       TEXT NOT NULL,
      from_pid   TEXT,
      reel_id    BIGINT,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_pid, id DESC);
  `);
}

const norm = (e) => String(e || '').trim().toLowerCase();
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 50) || null;
const cleanHandle = (h) => {
  let x = String(h || '').trim().replace(/\s+/g, '').slice(0, 31);
  if (!x) return null;
  if (!x.startsWith('@')) x = '@' + x;
  return x;
};
const toClient = (p) => p && ({ pid: p.pid, name: p.name || 'Gyanora user', handle: p.handle || null });

/* Create or refresh someone's public card. Only given fields change. */
async function upsertPerson({ email, name, handle }) {
  const e = norm(email); if (!e) return null;
  const pid = session.publicId(e);
  const n = cleanName(name), h = cleanHandle(handle);
  if (!HAS_DB) {
    for (const [oldPid, p] of memPeople) {
      if (p.email === e && oldPid !== pid) {          // id changed (secret rotated): move follows
        memFollows.forEach((f) => { if (f.follower === oldPid) f.follower = pid; if (f.followee === oldPid) f.followee = pid; });
        memPeople.delete(oldPid); p.pid = pid; memPeople.set(pid, p);
      }
    }
    const cur = memPeople.get(pid) || { pid, email: e, name: null, handle: null, last_active: null, show_active: false, allow_mentions: true, comment_permission: 'Everyone' };
    if (n) cur.name = n; if (h) cur.handle = h;
    memPeople.set(pid, cur);
    return toClient(cur);
  }
  /* If AUTH_SECRET was ever changed, this person's public id changed too:
     move their row and follows to the new id instead of failing. */
  const { rows: prev } = await getPool().query('SELECT pid FROM people WHERE email=$1', [e]);
  if (prev.length && prev[0].pid !== pid) {
    const old = prev[0].pid;
    await getPool().query('DELETE FROM follows WHERE (follower=$1 AND followee IN (SELECT followee FROM follows WHERE follower=$2)) OR (followee=$1 AND follower IN (SELECT follower FROM follows WHERE followee=$2))', [old, pid]);
    await getPool().query('UPDATE follows SET follower=$2 WHERE follower=$1', [old, pid]);
    await getPool().query('UPDATE follows SET followee=$2 WHERE followee=$1', [old, pid]);
    await getPool().query('DELETE FROM people WHERE pid=$1', [pid]);
    await getPool().query('UPDATE people SET pid=$2 WHERE pid=$1', [old, pid]);
  }
  const { rows } = await getPool().query(
    `INSERT INTO people (pid, email, name, handle) VALUES ($1,$2,$3,$4)
     ON CONFLICT (pid) DO UPDATE SET name=COALESCE($3, people.name), handle=COALESCE($4, people.handle), updated_at=now()
     RETURNING pid, name, handle`, [pid, e, n, h]
  );
  return toClient(rows[0]);
}

async function getPerson(pid) {
  if (!pid) return null;
  if (!HAS_DB) return memPeople.get(pid) || null;
  const { rows } = await getPool().query('SELECT pid, email, name, handle, show_active, allow_mentions, last_active, comment_permission FROM people WHERE pid=$1', [pid]);
  return rows[0] || null;
}

async function counts(pid) {
  if (!HAS_DB) {
    return { followers: memFollows.filter((f) => f.followee === pid).length, following: memFollows.filter((f) => f.follower === pid).length };
  }
  const { rows } = await getPool().query(
    `SELECT (SELECT COUNT(*)::int FROM follows WHERE followee=$1) AS followers,
            (SELECT COUNT(*)::int FROM follows WHERE follower=$1) AS following`, [pid]
  );
  return rows[0];
}

/* Follow (want=true) or unfollow (want=false). Returns the new state and
   the followee's follower count. */
async function setFollow(followerEmail, followeePid, want) {
  const me = session.publicId(followerEmail);
  if (!me) throw new Error('no user');
  if (me === followeePid) throw new Error('self');
  const target = await getPerson(followeePid);
  if (!target) throw new Error('not found');
  if (!HAS_DB) {
    const i = memFollows.findIndex((f) => f.follower === me && f.followee === followeePid);
    if (want && i < 0) { memFollows.push({ follower: me, followee: followeePid, at: Date.now() }); await notifyNewFollower(me, followeePid); }
    if (!want && i >= 0) memFollows.splice(i, 1);
  } else if (want) {
    const ins = await getPool().query('INSERT INTO follows (follower, followee) VALUES ($1,$2) ON CONFLICT DO NOTHING', [me, followeePid]);
    if (ins.rowCount) await notifyNewFollower(me, followeePid);
  } else {
    await getPool().query('DELETE FROM follows WHERE follower=$1 AND followee=$2', [me, followeePid]);
  }
  return { following: !!want, followers: (await counts(followeePid)).followers };
}

/* One page of someone's followers or following, newest first, with
   whether the viewer follows each person. */
async function list(pid, kind, viewerPid, { limit = 50, offset = 0 } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const mineCol = kind === 'followers' ? 'follower' : 'followee';
  const keyCol = kind === 'followers' ? 'followee' : 'follower';
  let people;
  if (!HAS_DB) {
    const rows = memFollows.filter((f) => f[keyCol] === pid).sort((a, b) => b.at - a.at);
    people = rows.slice(off, off + lim).map((f) => memPeople.get(f[mineCol])).filter(Boolean);
  } else {
    const { rows } = await getPool().query(
      `SELECT p.pid, p.name, p.handle FROM follows f JOIN people p ON p.pid = f.${mineCol}
       WHERE f.${keyCol}=$1 ORDER BY f.created_at DESC, p.pid LIMIT $2 OFFSET $3`, [pid, lim, off]
    );
    people = rows;
  }
  const out = people.map(toClient);
  const youFollow = await followingAmong(viewerPid, out.map((p) => p.pid));
  const followsYou = await followersAmong(viewerPid, out.map((p) => p.pid));
  out.forEach((p) => { p.youFollow = youFollow.has(p.pid); p.followsYou = followsYou.has(p.pid); p.you = p.pid === viewerPid; });
  return { people: out, nextOffset: out.length === lim ? off + lim : null };
}

async function followingAmong(viewerPid, pids) {
  if (!viewerPid || !pids.length) return new Set();
  if (!HAS_DB) return new Set(memFollows.filter((f) => f.follower === viewerPid && pids.includes(f.followee)).map((f) => f.followee));
  const { rows } = await getPool().query('SELECT followee FROM follows WHERE follower=$1 AND followee = ANY($2::text[])', [viewerPid, pids]);
  return new Set(rows.map((r) => r.followee));
}
async function followersAmong(viewerPid, pids) {
  if (!viewerPid || !pids.length) return new Set();
  if (!HAS_DB) return new Set(memFollows.filter((f) => f.followee === viewerPid && pids.includes(f.follower)).map((f) => f.follower));
  const { rows } = await getPool().query('SELECT follower FROM follows WHERE followee=$1 AND follower = ANY($2::text[])', [viewerPid, pids]);
  return new Set(rows.map((r) => r.follower));
}

/* Everyone the user follows (ids), for the app's Follow buttons. */
async function followingIds(email, max = 5000) {
  const me = session.publicId(email);
  if (!HAS_DB) return memFollows.filter((f) => f.follower === me).sort((a, b) => b.at - a.at).slice(0, max).map((f) => f.followee);
  const { rows } = await getPool().query('SELECT followee FROM follows WHERE follower=$1 ORDER BY created_at DESC LIMIT $2', [me, max]);
  return rows.map((r) => r.followee);
}

/* Emails of the accounts this user follows (server-side only: Following feed). */
async function followeeEmails(email, max = 5000) {
  const me = session.publicId(email);
  if (!HAS_DB) return memFollows.filter((f) => f.follower === me).slice(0, max).map((f) => (memPeople.get(f.followee) || {}).email).filter(Boolean);
  const { rows } = await getPool().query(
    'SELECT p.email FROM follows f JOIN people p ON p.pid=f.followee WHERE f.follower=$1 LIMIT $2', [me, max]
  );
  return rows.map((r) => r.email);
}

/* Resolve an old phone-only follow (by @handle) to an account, only when
   exactly one person uses that handle. */
async function pidByHandle(handle) {
  const h = cleanHandle(handle); if (!h) return null;
  if (!HAS_DB) {
    const m = [...memPeople.values()].filter((p) => (p.handle || '').toLowerCase() === h.toLowerCase());
    return m.length === 1 ? m[0].pid : null;
  }
  const { rows } = await getPool().query('SELECT pid FROM people WHERE lower(handle)=lower($1) LIMIT 2', [h]);
  return rows.length === 1 ? rows[0].pid : null;
}

/* Account deletion: remove the person and every follow in either direction. */
async function deleteUser(email) {
  const pid = session.publicId(email); if (!pid) return;
  if (!HAS_DB) {
    for (let i = memFollows.length - 1; i >= 0; i--) if (memFollows[i].follower === pid || memFollows[i].followee === pid) memFollows.splice(i, 1);
    for (let i = memNotes.length - 1; i >= 0; i--) if (memNotes[i].user_pid === pid || memNotes[i].from_pid === pid) memNotes.splice(i, 1);
    memPeople.delete(pid); memDevices.delete(pid);
    return;
  }
  await getPool().query('DELETE FROM follows WHERE follower=$1 OR followee=$1', [pid]);
  await getPool().query('DELETE FROM notifications WHERE user_pid=$1 OR from_pid=$1', [pid]);
  await getPool().query('DELETE FROM login_devices WHERE pid=$1', [pid]);
  await getPool().query('DELETE FROM people WHERE pid=$1', [pid]);
}

/* Existing accounts (from before this feature) get a public card at
   startup: name from the users table, @handle from their latest reel. */
async function backfill() {
  if (!HAS_DB) return 0;
  const { rows: users } = await getPool().query(
    `SELECT u.email, u.name FROM users u LEFT JOIN people p ON p.email = lower(u.email) WHERE p.pid IS NULL LIMIT 50000`
  ).catch(() => ({ rows: [] }));
  const { rows: handles } = await getPool().query(
    `SELECT DISTINCT ON (owner_id) owner_id, creator FROM reels WHERE owner_id IS NOT NULL ORDER BY owner_id, id DESC`
  ).catch(() => ({ rows: [] }));
  const handleOf = new Map(handles.map((r) => [String(r.owner_id).toLowerCase(), r.creator]));
  for (const u of users) await upsertPerson({ email: u.email, name: u.name, handle: handleOf.get(norm(u.email)) });
  return users.length;
}

/* ================= Active status ================= */
/* Called by the app while it's open: records "last active" and the user's
   two privacy switches. */
async function setPresence(email, { showActive, allowMentions, commentPermission } = {}) {
  const cp = COMMENT_PERMS.includes(commentPermission) ? commentPermission : null;
  const pid = session.publicId(email); if (!pid) return null;
  if (!(await getPerson(pid))) await upsertPerson({ email });
  const sa = typeof showActive === 'boolean' ? showActive : null;
  const am = typeof allowMentions === 'boolean' ? allowMentions : null;
  if (!HAS_DB) {
    const p = memPeople.get(pid); p.last_active = new Date();
    if (sa !== null) p.show_active = sa; if (am !== null) p.allow_mentions = am; if (cp) p.comment_permission = cp;
    return pid;
  }
  await getPool().query(
    `UPDATE people SET last_active=now(), show_active=COALESCE($2, show_active), allow_mentions=COALESCE($3, allow_mentions),
       comment_permission=COALESCE($4, comment_permission) WHERE pid=$1`,
    [pid, sa, am, cp]
  );
  return pid;
}
/* Last-active times the viewer is ALLOWED to see: only for people who have
   "Show active status" on, whom the viewer follows, and only if the viewer
   shares theirs too (like Instagram). Returns Map pid -> ms timestamp. */
async function activeTimes(viewerPid, pids) {
  const out = new Map();
  const ids = [...new Set((pids || []).filter(Boolean))].filter((x) => x !== viewerPid);
  if (!viewerPid || !ids.length) return out;
  const me = await getPerson(viewerPid);
  if (!me || !me.show_active) return out;
  const followed = await followingAmong(viewerPid, ids);
  const allowed = ids.filter((x) => followed.has(x));
  if (!allowed.length) return out;
  if (!HAS_DB) {
    allowed.forEach((x) => { const p = memPeople.get(x); if (p && p.show_active && p.last_active) out.set(x, new Date(p.last_active).getTime()); });
    return out;
  }
  const { rows } = await getPool().query(
    'SELECT pid, last_active FROM people WHERE pid = ANY($1::text[]) AND show_active AND last_active IS NOT NULL', [allowed]
  );
  rows.forEach((r) => out.set(r.pid, new Date(r.last_active).getTime()));
  return out;
}

/* ================= Mentions ================= */
/* People to suggest after typing "@": handle or name starts with q; people
   with "Allow mentions" off are never suggested. People the viewer follows
   (or who follow the viewer) come first. */
async function searchPeople(q, viewerPid, limit = 8, { forMentions = true } = {}) {
  const term = String(q || '').replace(/^@/, '').trim().toLowerCase().slice(0, 30);
  let rows;
  if (!HAS_DB) {
    rows = [...memPeople.values()].filter((p) => (!forMentions || p.allow_mentions !== false) && (forMentions ? p.handle : true) && p.pid !== viewerPid &&
      (!term || (p.handle || '').slice(1).toLowerCase().startsWith(term) || (p.name || '').toLowerCase().split(/\s+/).some((w) => w.startsWith(term))));
  } else {
    const like = term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    ({ rows } = await getPool().query(
      `SELECT pid, name, handle FROM people
        WHERE ($3::boolean IS FALSE OR (allow_mentions AND handle IS NOT NULL)) AND pid <> $2
          AND (lower(substr(handle,2)) LIKE $1 OR lower(name) LIKE $1 OR lower(name) LIKE '% ' || $1)
        LIMIT 60`, [like, viewerPid || '', !!forMentions]
    ));
  }
  const close = new Set([...(await followingAmong(viewerPid, rows.map((r) => r.pid))), ...(await followersAmong(viewerPid, rows.map((r) => r.pid)))]);
  return rows.sort((a, b) => (close.has(b.pid) ? 1 : 0) - (close.has(a.pid) ? 1 : 0))
    .slice(0, limit).map((p) => ({ pid: p.pid, name: p.name || 'Gyanora user', handle: p.handle }));
}
/* "@handle" words in a comment -> the people they refer to (one person per
   handle; handles used by several people are skipped). */
async function resolveMentions(text) {
  const handles = [...new Set((String(text || '').match(/@[A-Za-z0-9._]{1,30}/g) || []).map((h) => h.toLowerCase()))].slice(0, 10);
  const out = [];
  for (const h of handles) {
    let matches;
    if (!HAS_DB) matches = [...memPeople.values()].filter((p) => (p.handle || '').toLowerCase() === h);
    else ({ rows: matches } = await getPool().query('SELECT pid, handle, allow_mentions FROM people WHERE lower(handle)=$1 LIMIT 2', [h]));
    if (matches.length === 1) out.push({ pid: matches[0].pid, handle: matches[0].handle, allow: matches[0].allow_mentions !== false });
  }
  return out;
}

/* ================= Notifications ================= */
async function notify(userPid, type, fromPid, text, reelId = null) {
  if (!userPid || userPid === fromPid) return;
  const t = String(text || '').slice(0, 200);
  if (!HAS_DB) memNotes.push({ id: ++memNoteId, user_pid: userPid, type, from_pid: fromPid, reel_id: reelId, text: t, created_at: new Date() });
  else await getPool().query('INSERT INTO notifications (user_pid, type, from_pid, reel_id, text) VALUES ($1,$2,$3,$4,$5)', [userPid, type, fromPid, reelId, t]);
  // Also as a push notification to their phones (when Firebase is set up).
  require('./push-service').send(userPid, type, t, reelId).catch(() => {});
}
async function notifyNewFollower(fromPid, toPid) {
  const from = await getPerson(fromPid);
  await notify(toPid, 'follow', fromPid, `${(from && from.name) || 'Someone'} started following you`).catch(() => {});
}
/* Newest notifications for a person after `since` (an id), max 50. */
async function listNotifications(pid, since = 0) {
  const after = Math.max(0, Number(since) || 0);
  let rows;
  if (!HAS_DB) rows = memNotes.filter((n) => n.user_pid === pid && n.id > after).sort((a, b) => b.id - a.id).slice(0, 50);
  else ({ rows } = await getPool().query('SELECT * FROM notifications WHERE user_pid=$1 AND id>$2 ORDER BY id DESC LIMIT 50', [pid, after]));
  return rows.map((n) => ({ id: Number(n.id), type: n.type, text: n.text, reelId: n.reel_id == null ? null : Number(n.reel_id), at: new Date(n.created_at).getTime() }));
}

/* ================= Who can comment ================= */
/* The reel owner's "Who can comment" setting, applied to a commenter.
   The owner can always comment on their own reels. */
async function canComment(ownerEmail, commenterEmail) {
  const owner = session.publicId(ownerEmail), me = session.publicId(commenterEmail);
  if (!owner || owner === me) return { ok: true };
  const p = await getPerson(owner);
  const perm = (p && p.comment_permission) || 'Everyone';
  if (perm === 'Everyone') return { ok: true };
  if (perm === 'Nobody') return { ok: false, reason: 'The creator has turned off comments on their reels.' };
  if (!me) return { ok: false, reason: 'Log in to comment.' };
  if (perm === 'Followers') {
    return (await followingAmong(me, [owner])).has(owner) ? { ok: true } : { ok: false, reason: 'Only followers of this creator can comment. Follow them to join the conversation.' };
  }
  return (await followingAmong(owner, [me])).has(me) ? { ok: true } : { ok: false, reason: 'Only people this creator follows can comment.' };
}

/* ================= New sign-in alerts ================= */
/* Remembers the phones an account signs in on. A sign-in from a phone not
   seen before (when the account already has others) notifies the account
   on its other phones. */
async function noteLogin(email, deviceId, { alert = true } = {}) {
  const pid = session.publicId(email);
  const dev = String(deviceId || '').slice(0, 64);
  if (!pid || !dev) return false;
  let isNew, hadOthers;
  if (!HAS_DB) {
    const set = memDevices.get(pid) || new Set();
    isNew = !set.has(dev); hadOthers = set.size > 0; set.add(dev); memDevices.set(pid, set);
  } else {
    const { rows } = await getPool().query('SELECT COUNT(*)::int AS n FROM login_devices WHERE pid=$1', [pid]);
    hadOthers = rows[0].n > 0;
    const ins = await getPool().query('INSERT INTO login_devices (pid, device_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [pid, dev]);
    isNew = ins.rowCount > 0;
  }
  if (alert && isNew && hadOthers) {
    const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
    await notify(pid, 'login', null, `New sign-in to your account on another phone (${when}). If this wasn't you, reset your password.`);
  }
  return isNew;
}

/* Does a follow b? */
async function isFollowing(aPid, bPid) { return (await followingAmong(aPid, [bPid])).has(bPid); }

module.exports = {
  isFollowing, canComment, noteLogin, setPresence, activeTimes, searchPeople, resolveMentions, notify, listNotifications,
  backfill, initSchema, upsertPerson, getPerson, counts, setFollow, list, followingIds, followeeEmails,
  pidByHandle, deleteUser, publicId: session.publicId, HAS_DB,
};
