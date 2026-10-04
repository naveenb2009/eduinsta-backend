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

const memPeople = new Map();   // pid -> {pid,email,name,handle}
const memFollows = [];         // {follower, followee, at}

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
const toClient = (p) => p && ({ pid: p.pid, name: p.name || 'EduInsta user', handle: p.handle || null });

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
    const cur = memPeople.get(pid) || { pid, email: e, name: null, handle: null };
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
  const { rows } = await getPool().query('SELECT pid, email, name, handle FROM people WHERE pid=$1', [pid]);
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
    if (want && i < 0) memFollows.push({ follower: me, followee: followeePid, at: Date.now() });
    if (!want && i >= 0) memFollows.splice(i, 1);
  } else if (want) {
    await getPool().query('INSERT INTO follows (follower, followee) VALUES ($1,$2) ON CONFLICT DO NOTHING', [me, followeePid]);
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
    memPeople.delete(pid);
    return;
  }
  await getPool().query('DELETE FROM follows WHERE follower=$1 OR followee=$1', [pid]);
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

module.exports = {
  backfill, initSchema, upsertPerson, getPerson, counts, setFollow, list, followingIds, followeeEmails,
  pidByHandle, deleteUser, publicId: session.publicId, HAS_DB,
};
