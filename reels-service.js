/**
 * Shared reel storage — the piece that turns EduInsta from a single-device
 * demo into a real platform.
 *
 * Before: uploads went into the uploader's own IndexedDB, so nobody else
 * could ever see them. Here the video goes to object storage, the metadata
 * goes to Postgres, and every user's feed reads the same table.
 *
 * STORAGE CHOICE
 * --------------
 * Cloudflare R2 is used because it charges NOTHING for egress. Video is
 * bandwidth-heavy; on S3 the egress bill typically dwarfs the storage bill.
 * R2 speaks the S3 API, so the same SDK works and you can move later.
 *
 * FALLBACK
 * --------
 * If R2/DB env vars are missing the module runs in MEMORY MODE: uploads are
 * kept in process memory so you can develop and test the whole flow before
 * signing up for anything. Memory mode is lost on restart — it is not for
 * production, and the server logs a warning at boot.
 */

const crypto = require('crypto');

const HAS_R2 = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
                  process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
const HAS_DB = !!process.env.DATABASE_URL;

/* ------------------------------------------------------------------
   Object storage
   ------------------------------------------------------------------ */
let s3 = null;
function getS3() {
  if (s3 || !HAS_R2) return s3;
  const { S3Client } = require('@aws-sdk/client-s3');
  s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return s3;
}

const memoryVideos = new Map();   // key -> { buffer, mime }  (memory mode only)

async function storeVideo(buffer, mimeType) {
  const ext = (mimeType || 'video/mp4').split('/')[1].replace(/[^a-z0-9]/gi, '') || 'mp4';
  const key = `reels/${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${ext}`;

  if (!HAS_R2) {
    memoryVideos.set(key, { buffer, mime: mimeType || 'video/mp4' });
    return { key, url: publicUrlFor(key) };
  }

  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await getS3().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType || 'video/mp4',
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return { key, url: publicUrlFor(key) };
}

/* Same idea as storeVideo, but for profile photos - kept as its own function
   (rather than a shared prefix parameter) so the reel-upload path can't be
   accidentally affected by changes made here. Reuses the same R2 client and
   the same memory-mode map: keys are unique (prefixed "avatars/"), so there's
   no collision with reel video keys. */
async function storeImage(buffer, mimeType) {
  const ext = (mimeType || 'image/jpeg').split('/')[1].replace(/[^a-z0-9]/gi, '') || 'jpg';
  const key = `avatars/${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${ext}`;

  if (!HAS_R2) {
    memoryVideos.set(key, { buffer, mime: mimeType || 'image/jpeg' });
    return { key, url: publicUrlFor(key) };
  }

  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await getS3().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType || 'image/jpeg',
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return { key, url: publicUrlFor(key) };
}

/* Build the URL a client should fetch the video from.
   Order of preference:
     1. R2_PUBLIC_URL  - the bucket's own CDN domain (fastest, no server load)
     2. PUBLIC_BASE_URL- this server's absolute address
     3. relative path  - last resort; the app resolves it against API_BASE
   A RELATIVE path is dangerous for native apps: inside a Capacitor WebView the
   page origin is localhost, so "/api/video/x" resolves to https://localhost/...
   and the video silently fails to load. Always prefer an absolute URL. */
function publicUrlFor(key) {
  const cdn = process.env.R2_PUBLIC_URL;
  if (cdn) return `${cdn.replace(/\/$/, '')}/${key}`;
  const self = process.env.PUBLIC_BASE_URL;
  if (self) return `${self.replace(/\/$/, '')}/api/video/${encodeURIComponent(key)}`;
  return `/api/video/${encodeURIComponent(key)}`;
}

async function readVideo(key) {
  if (!HAS_R2) {
    const v = memoryVideos.get(key);
    if (!v) throw new Error('not found');
    return v;
  }
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const res = await getS3().send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET, Key: key,
  }));
  const chunks = [];
  for await (const c of res.Body) chunks.push(c);
  return { buffer: Buffer.concat(chunks), mime: res.ContentType || 'video/mp4' };
}

async function deleteVideo(key) {
  if (!HAS_R2) { memoryVideos.delete(key); return; }
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await getS3().send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
}

/* ------------------------------------------------------------------
   Metadata
   ------------------------------------------------------------------ */
let pool = null;
function getPool() {
  if (pool || !HAS_DB) return pool;
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}

const memoryReels = [];   // memory mode
/* Date.now() alone collides when several reels are created in the same
   millisecond, which made cursor pagination return overlapping pages and
   would have given two reels the same id in the app. A monotonic counter
   guarantees uniqueness. (Postgres uses BIGSERIAL and has no such problem.) */
let __memIdSeq = 0;
function nextMemoryId() { return Date.now() * 1000 + (__memIdSeq++ % 1000); }

async function initSchema() {
  if (!HAS_DB) {
    console.warn('⚠️  MEMORY MODE: no DATABASE_URL. Reels are lost on restart. Fine for testing, not production.');
    return;
  }
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS reels (
      id           BIGSERIAL PRIMARY KEY,
      creator      TEXT NOT NULL,
      title        TEXT NOT NULL,
      description  TEXT,
      category     TEXT,
      subject      TEXT,
      video_key    TEXT NOT NULL,
      video_url    TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'published',
      likes        INTEGER NOT NULL DEFAULT 0,
      views        INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS reels_created_idx ON reels (created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS reels_creator_idx ON reels (creator);
    -- Account (email) that uploaded the reel. The public @creator handle can
    -- be changed or copied, so ownership (delete, account deletion, "my
    -- uploads") is decided by this column instead. NULL for reels uploaded
    -- before it existed.
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS owner_id TEXT;
    CREATE INDEX IF NOT EXISTS reels_owner_idx ON reels (owner_id);

    CREATE TABLE IF NOT EXISTS reel_likes (
      reel_id  BIGINT NOT NULL,
      user_id  TEXT   NOT NULL,
      PRIMARY KEY (reel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS profiles (
      user_id     TEXT PRIMARY KEY,
      avatar_key  TEXT,
      avatar_url  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS reel_comments (
      id          BIGSERIAL PRIMARY KEY,
      reel_id     BIGINT NOT NULL,
      user_id     TEXT NOT NULL,
      username    TEXT,
      text        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS reel_comments_reel_idx ON reel_comments (reel_id, id);
    CREATE INDEX IF NOT EXISTS reel_comments_user_idx ON reel_comments (user_id);
  `);
  if (!HAS_R2) console.warn('⚠️  No R2 configured — videos are held in memory and lost on restart.');
}

async function createReel({ creator, title, description, category, subject, videoKey, videoUrl, ownerId = null }) {
  ownerId = ownerId ? String(ownerId).trim().toLowerCase() : null;
  if (!HAS_DB) {
    const row = {
      id: nextMemoryId(), creator, title, description, category, subject, owner_id: ownerId,
      video_key: videoKey, video_url: videoUrl, status: 'published',
      likes: 0, views: 0, created_at: new Date().toISOString(),
    };
    memoryReels.unshift(row);
    return row;
  }
  const { rows } = await getPool().query(
    `INSERT INTO reels (creator,title,description,category,subject,video_key,video_url,owner_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [creator, title, description || '', category || '', subject || '', videoKey, videoUrl, ownerId]
  );
  return rows[0];
}

/* Keyset pagination, not OFFSET. With OFFSET the database still scans every
   skipped row, so page 500 gets slow; a cursor stays fast at any depth. */
async function listReels({ limit = 10, cursor = null, creator = null } = {}) {
  const lim = Math.min(50, Math.max(1, Number(limit) || 10));

  if (!HAS_DB) {
    let items = memoryReels.filter((r) => !creator || r.creator === creator);
    if (cursor) {
      const i = items.findIndex((r) => String(r.id) === String(cursor));
      items = i >= 0 ? items.slice(i + 1) : items;
    }
    const page = items.slice(0, lim);
    return { items: page, nextCursor: page.length === lim ? String(page[page.length - 1].id) : null };
  }

  const params = [];
  let where = `WHERE status = 'published'`;
  if (creator) { params.push(creator); where += ` AND creator = $${params.length}`; }
  if (cursor)  { params.push(cursor);  where += ` AND id < $${params.length}`; }
  params.push(lim);

  const { rows } = await getPool().query(
    `SELECT * FROM reels ${where} ORDER BY id DESC LIMIT $${params.length}`, params
  );
  return { items: rows, nextCursor: rows.length === lim ? String(rows[rows.length - 1].id) : null };
}

/* Likes are per-user rows, so the count can't be inflated by tapping twice
   and survives the user reinstalling the app. */
async function toggleLike(reelId, userId) {
  if (!HAS_DB) {
    const r = memoryReels.find((x) => String(x.id) === String(reelId));
    if (!r) throw new Error('not found');
    r._likers = r._likers || new Set();
    const liked = !r._likers.has(userId);
    liked ? r._likers.add(userId) : r._likers.delete(userId);
    r.likes = r._likers.size;
    return { liked, likes: r.likes };
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT 1 FROM reel_likes WHERE reel_id=$1 AND user_id=$2', [reelId, userId]
    );
    let liked;
    if (existing.rowCount) {
      await client.query('DELETE FROM reel_likes WHERE reel_id=$1 AND user_id=$2', [reelId, userId]);
      liked = false;
    } else {
      await client.query('INSERT INTO reel_likes (reel_id,user_id) VALUES ($1,$2)', [reelId, userId]);
      liked = true;
    }
    const { rows } = await client.query(
      `UPDATE reels SET likes = (SELECT COUNT(*) FROM reel_likes WHERE reel_id=$1)
       WHERE id=$1 RETURNING likes`, [reelId]
    );
    await client.query('COMMIT');
    return { liked, likes: rows[0]?.likes ?? 0 };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function incrementViews(reelId) {
  if (!HAS_DB) {
    const r = memoryReels.find((x) => String(x.id) === String(reelId));
    if (r) r.views = (r.views || 0) + 1;
    return;
  }
  await getPool().query('UPDATE reels SET views = views + 1 WHERE id = $1', [reelId]);
}

async function deleteReel(reelId, creator) {
  if (!HAS_DB) {
    const i = memoryReels.findIndex((x) => String(x.id) === String(reelId) && x.creator === creator);
    if (i < 0) return false;
    await deleteVideo(memoryReels[i].video_key).catch(() => {});
    memoryReels.splice(i, 1);
    await deleteCommentsForReel(reelId).catch(() => {});
    return true;
  }
  const { rows } = await getPool().query(
    'DELETE FROM reels WHERE id=$1 AND creator=$2 RETURNING video_key', [reelId, creator]
  );
  if (!rows.length) return false;
  await deleteVideo(rows[0].video_key).catch(() => {});
  await deleteCommentsForReel(reelId).catch(() => {});
  return true;
}

/* Deletes EVERY reel a user has ever uploaded, including their stored video
   files -- used by account deletion (GDPR/Play Store "delete my data"
   requirement), not by the normal single-reel delete flow above. */
async function deleteAllReelsByCreator(creator) {
  if (!HAS_DB) {
    const mine = memoryReels.filter((x) => x.creator === creator);
    for (const r of mine) {
      await deleteVideo(r.video_key).catch(() => {});
      await deleteCommentsForReel(r.id).catch(() => {});
    }
    const before = memoryReels.length;
    for (let i = memoryReels.length - 1; i >= 0; i--) {
      if (memoryReels[i].creator === creator) memoryReels.splice(i, 1);
    }
    return before - memoryReels.length;
  }
  const { rows } = await getPool().query(
    'DELETE FROM reels WHERE creator=$1 RETURNING id, video_key', [creator]
  );
  for (const row of rows) {
    await deleteVideo(row.video_key).catch(() => {});
    await deleteCommentsForReel(row.id).catch(() => {});
  }
  return rows.length;
}

/* ------------------------------------------------------------------
   Profile photos — shared server-side so other users can actually see
   them (previously the photo only lived in the uploader's own browser
   storage, so nobody else could ever see it).
   ------------------------------------------------------------------ */
const memoryProfiles = new Map();   // userId -> { avatarKey, avatarUrl }  (memory mode)

async function getAvatarRecord(userId) {
  if (!HAS_DB) return memoryProfiles.get(userId) || null;
  const { rows } = await getPool().query(
    'SELECT avatar_key, avatar_url FROM profiles WHERE user_id=$1', [userId]
  );
  if (!rows.length) return null;
  return { avatarKey: rows[0].avatar_key, avatarUrl: rows[0].avatar_url };
}

/* Uploads the new photo, points the user's profile row at it, then removes
   the OLD photo file (if any) so replaced avatars don't pile up in storage. */
async function setAvatar(userId, buffer, mimeType) {
  const old = await getAvatarRecord(userId);
  const { key, url } = await storeImage(buffer, mimeType);

  if (!HAS_DB) {
    memoryProfiles.set(userId, { avatarKey: key, avatarUrl: url });
  } else {
    await getPool().query(
      `INSERT INTO profiles (user_id, avatar_key, avatar_url, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (user_id) DO UPDATE SET avatar_key=$2, avatar_url=$3, updated_at=now()`,
      [userId, key, url]
    );
  }

  if (old?.avatarKey && old.avatarKey !== key) await deleteVideo(old.avatarKey).catch(() => {});
  return url;
}

/* Batch lookup - the feed calls this once per page with every creator id it
   needs, rather than one request per reel. */
async function getAvatars(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return {};

  if (!HAS_DB) {
    const out = {};
    ids.forEach((id) => {
      const r = memoryProfiles.get(id);
      if (r) out[id] = r.avatarUrl;
    });
    return out;
  }

  const { rows } = await getPool().query(
    'SELECT user_id, avatar_url FROM profiles WHERE user_id = ANY($1)', [ids]
  );
  const out = {};
  rows.forEach((r) => { out[r.user_id] = r.avatar_url; });
  return out;
}

async function deleteAvatar(userId) {
  const rec = await getAvatarRecord(userId);
  if (!rec) return;
  if (rec.avatarKey) await deleteVideo(rec.avatarKey).catch(() => {});
  if (!HAS_DB) { memoryProfiles.delete(userId); return; }
  await getPool().query('DELETE FROM profiles WHERE user_id=$1', [userId]);
}

/* ------------------------------------------------------------------
   Comments — now shared server-side so a comment posted by one user is
   visible to everyone viewing that reel (previously kept in the poster's
   own browser storage only, so nobody else could ever see it). Still
   unmoderated, same as before — this only changes WHERE comments live,
   not whether they're reviewed before appearing.
   ------------------------------------------------------------------ */
const MAX_COMMENT_LENGTH = 300;
const memoryComments = new Map();   // String(reelId) -> [{id,reel_id,user_id,username,text,created_at}]

async function addComment(reelId, userId, username, text) {
  const clean = String(text || '').trim().slice(0, MAX_COMMENT_LENGTH);
  if (!clean) throw new Error('Comment text is required');
  if (!userId) throw new Error('userId is required');

  if (!HAS_DB) {
    const row = {
      id: nextMemoryId(), reel_id: reelId, user_id: userId,
      username: username || userId, text: clean, created_at: new Date().toISOString(),
    };
    const arr = memoryComments.get(String(reelId)) || [];
    arr.push(row);
    memoryComments.set(String(reelId), arr);
    return row;
  }

  const { rows } = await getPool().query(
    `INSERT INTO reel_comments (reel_id, user_id, username, text) VALUES ($1,$2,$3,$4) RETURNING *`,
    [reelId, userId, username || userId, clean]
  );
  return rows[0];
}

/* Oldest-first, capped — matches how the app already renders them (each
   new comment appended to the bottom of the list). */
async function listComments(reelId, { limit = 200 } = {}) {
  const lim = Math.min(300, Math.max(1, Number(limit) || 200));

  if (!HAS_DB) {
    const arr = memoryComments.get(String(reelId)) || [];
    return arr.slice(-lim);
  }

  const { rows } = await getPool().query(
    `SELECT * FROM reel_comments WHERE reel_id=$1 ORDER BY id ASC LIMIT $2`, [reelId, lim]
  );
  return rows;
}

async function deleteCommentsForReel(reelId) {
  if (!HAS_DB) { memoryComments.delete(String(reelId)); return; }
  await getPool().query('DELETE FROM reel_comments WHERE reel_id=$1', [reelId]);
}

/* Removes every comment a user has ever POSTED, including on other
   people's reels -- used by account deletion. (Comments ON their own
   reels are already covered by deleteCommentsForReel via deleteReel /
   deleteAllReelsByCreator.) */
async function deleteCommentsByUser(userId) {
  if (!HAS_DB) {
    let removed = 0;
    for (const [key, arr] of memoryComments) {
      const kept = arr.filter((c) => c.user_id !== userId);
      removed += arr.length - kept.length;
      memoryComments.set(key, kept);
    }
    return removed;
  }
  const { rowCount } = await getPool().query('DELETE FROM reel_comments WHERE user_id=$1', [userId]);
  return rowCount;
}

function toClientComment(row) {
  return { id: Number(row.id), user: row.username || row.user_id, text: row.text, createdAt: row.created_at };
}

/* Fetch a single published reel by id - used by the /reel/:id shareable
   landing page (Open Graph preview + Android App Link target). */
async function getReel(reelId) {
  if (!HAS_DB) {
    return memoryReels.find((r) => String(r.id) === String(reelId)) || null;
  }
  const { rows } = await getPool().query(
    `SELECT * FROM reels WHERE id = $1 AND status = 'published'`, [reelId]
  );
  return rows[0] || null;
}

/* Fetch several reels by id in one call - used by the profile page's Saved
   and Watch history tabs, which only have a list of ids (from the user's own
   local storage) and need the full reel objects to render, regardless of
   whether those reels are still on the first page of the main feed. */
async function getReelsByIds(ids) {
  const numeric = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (!numeric.length) return [];

  if (!HAS_DB) {
    const wanted = new Set(numeric.map(String));
    return memoryReels.filter((r) => wanted.has(String(r.id)));
  }
  const { rows } = await getPool().query(
    `SELECT * FROM reels WHERE id = ANY($1::bigint[]) AND status = 'published'`, [numeric]
  );
  return rows;
}

/* Shape rows the way the app already expects, so the client barely changes. */
function toClientReel(row) {
  return {
    id: Number(row.id),
    creator: row.creator,
    title: row.title,
    desc: row.description,
    cat: row.category,
    sub: row.subject,
    src: row.video_url,
    likes: row.likes,
    views: row.views,
    createdAt: row.created_at,
  };
}

/* ---- Ownership-based operations (owner_id = uploader's account email) ---- */
async function removeReelRow(row) {
  await deleteVideo(row.video_key).catch(() => {});
  await deleteCommentsForReel(row.id).catch(() => {});
  if (HAS_DB) await getPool().query('DELETE FROM reel_likes WHERE reel_id=$1', [row.id]).catch(() => {});
}

/* A creator deleting one of their own reels. Returns true only when the reel
   exists AND belongs to ownerId. */
async function deleteOwnReel(reelId, ownerId) {
  const owner = String(ownerId || '').trim().toLowerCase();
  if (!owner) return false;
  if (!HAS_DB) {
    const i = memoryReels.findIndex((x) => String(x.id) === String(reelId) && x.owner_id === owner);
    if (i < 0) return false;
    const [row] = memoryReels.splice(i, 1);
    await removeReelRow(row);
    return true;
  }
  const { rows } = await getPool().query(
    'DELETE FROM reels WHERE id=$1 AND owner_id=$2 RETURNING id, video_key', [reelId, owner]
  );
  if (!rows.length) return false;
  await removeReelRow(rows[0]);
  return true;
}

/* Every reel owned by this account (used by account deletion). */
async function deleteAllReelsByOwner(ownerId) {
  const owner = String(ownerId || '').trim().toLowerCase();
  if (!owner) return 0;
  if (!HAS_DB) {
    const mine = memoryReels.filter((x) => x.owner_id === owner);
    for (const r of mine) { memoryReels.splice(memoryReels.indexOf(r), 1); await removeReelRow(r); }
    return mine.length;
  }
  const { rows } = await getPool().query('DELETE FROM reels WHERE owner_id=$1 RETURNING id, video_key', [owner]);
  for (const row of rows) await removeReelRow(row);
  return rows.length;
}

/* "My uploads": reels owned by this account, plus older reels (no owner yet)
   posted under the given @handle. */
async function listOwnReels(ownerId, handle) {
  const owner = String(ownerId || '').trim().toLowerCase();
  if (!HAS_DB) {
    return memoryReels.filter((r) => (owner && r.owner_id === owner) || (!r.owner_id && handle && r.creator === handle)).slice(0, 100);
  }
  const { rows } = await getPool().query(
    `SELECT * FROM reels WHERE status='published' AND (owner_id=$1 OR (owner_id IS NULL AND creator=$2))
     ORDER BY id DESC LIMIT 100`, [owner, handle || '']
  );
  return rows;
}

module.exports = {
  deleteOwnReel, deleteAllReelsByOwner, listOwnReels,
  initSchema, storeVideo, readVideo, createReel, listReels, getReel, getReelsByIds,
  toggleLike, incrementViews, deleteReel, deleteAllReelsByCreator, toClientReel,
  storeImage, setAvatar, getAvatars, deleteAvatar,
  addComment, listComments, deleteCommentsForReel, deleteCommentsByUser, toClientComment,
  HAS_R2, HAS_DB,
};
