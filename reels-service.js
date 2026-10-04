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

    -- Engagement counters shown on every reel (like Instagram). likes is
    -- kept in sync with reel_likes; comment_count with reel_comments.
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS comment_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS share_count   INTEGER NOT NULL DEFAULT 0;
    -- Replies (one level, like Instagram) and hearts on comments.
    ALTER TABLE reel_comments ADD COLUMN IF NOT EXISTS parent_id BIGINT;
    ALTER TABLE reel_comments ADD COLUMN IF NOT EXISTS likes INTEGER NOT NULL DEFAULT 0;
    -- @handles in the comment that point at real people (JSON array), so the
    -- app can highlight them.
    ALTER TABLE reel_comments ADD COLUMN IF NOT EXISTS mentions TEXT;
    CREATE INDEX IF NOT EXISTS reel_comments_parent_idx ON reel_comments (parent_id);
    CREATE TABLE IF NOT EXISTS comment_likes (
      comment_id BIGINT NOT NULL,
      user_id    TEXT   NOT NULL,
      PRIMARY KEY (comment_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS comment_likes_user_idx ON comment_likes (user_id);
    -- When each like happened, so "who liked this" lists newest first.
    ALTER TABLE reel_likes ADD COLUMN IF NOT EXISTS liked_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS reel_likes_reel_time_idx ON reel_likes (reel_id, liked_at DESC, user_id);
    CREATE INDEX IF NOT EXISTS reel_likes_user_idx ON reel_likes (user_id);
    -- One-time catch-up for comments posted before the counter existed.
    UPDATE reels r SET comment_count = c.n
      FROM (SELECT reel_id, COUNT(*)::int AS n FROM reel_comments GROUP BY reel_id) c
     WHERE r.id = c.reel_id AND r.comment_count <> c.n;
  `);
  if (!HAS_R2) console.warn('⚠️  No R2 configured — videos are held in memory and lost on restart.');
}

async function createReel({ creator, title, description, category, subject, videoKey, videoUrl, ownerId = null }) {
  ownerId = ownerId ? String(ownerId).trim().toLowerCase() : null;
  if (!HAS_DB) {
    const row = {
      id: nextMemoryId(), creator, title, description, category, subject, owner_id: ownerId,
      video_key: videoKey, video_url: videoUrl, status: 'published',
      likes: 0, views: 0, comment_count: 0, share_count: 0, created_at: new Date().toISOString(),
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
/* Every reel stays listed until its uploader (or the owner) deletes it:
   there is no total cap. `limit` is only the size of ONE page - the app
   keeps asking for the next page (cursor) as the user scrolls, so a
   catalogue of any size is reachable, newest first.

   Optional filters (all combinable):
     creator   - one @handle
     creators  - several @handles (Following tab)
     topics    - categories/subjects (Explore chips)
     q         - search text; a reel matches if ANY word appears in its
                 title, description, category, subject or creator
     any       - comma-separated phrases (For You interests); a reel matches
                 if ANY phrase appears in those same fields */
const toList = (v, max) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((s) => String(s).trim()).filter(Boolean).slice(0, max);
const searchTerms = (q) => String(q || '').toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

async function listReels({ limit = 10, cursor = null, creator = null, creators = null, topics = null, q = null, any = null, owners = null } = {}) {
  const lim = Math.min(50, Math.max(1, Number(limit) || 10));
  const creatorList = creators ? toList(creators, 500) : [];
  const topicList = topics ? toList(topics, 200) : [];
  const terms = searchTerms(q);
  const phrases = any ? toList(any, 150).map((t) => t.toLowerCase()) : [];
  if (creators && !creatorList.length) return { items: [], nextCursor: null };
  /* owners: account emails (Following feed). Server-side only - never from the app. */
  const ownerList = Array.isArray(owners) ? owners.map((o) => String(o).toLowerCase()) : null;
  if (ownerList && !ownerList.length) return { items: [], nextCursor: null };

  if (!HAS_DB) {
    const topicSet = new Set(topicList.map((t) => t.toLowerCase()));
    let items = memoryReels.filter((r) => {
      if (creator && r.creator !== creator) return false;
      if (creatorList.length && !creatorList.includes(r.creator)) return false;
      if (ownerList && !ownerList.includes(String(r.owner_id || ''))) return false;
      if (topicSet.size && !topicSet.has(String(r.category || '').toLowerCase()) && !topicSet.has(String(r.subject || '').toLowerCase())) return false;
      if (terms.length) {
        const hay = [r.title, r.description, r.category, r.subject, r.creator].join(' ').toLowerCase();
        if (!terms.some((t) => hay.includes(t))) return false;
      }
      if (phrases.length) {
        const hay = [r.title, r.description, r.category, r.subject, r.creator].join(' ').toLowerCase();
        if (!phrases.some((t) => hay.includes(t))) return false;
      }
      return true;
    });
    if (cursor) items = items.filter((r) => Number(r.id) < Number(cursor));
    const page = items.slice(0, lim);
    return { items: page, nextCursor: page.length === lim ? String(page[page.length - 1].id) : null };
  }

  const params = [];
  let where = `WHERE status = 'published'`;
  if (creator) { params.push(creator); where += ` AND creator = $${params.length}`; }
  if (creatorList.length) { params.push(creatorList); where += ` AND creator = ANY($${params.length}::text[])`; }
  if (ownerList) { params.push(ownerList); where += ` AND owner_id = ANY($${params.length}::text[])`; }
  if (topicList.length) {
    params.push(topicList.map((t) => t.toLowerCase()));
    where += ` AND (lower(category) = ANY($${params.length}::text[]) OR lower(subject) = ANY($${params.length}::text[]))`;
  }
  if (terms.length) {
    const ors = terms.map((t) => {
      params.push('%' + likeEscape(t) + '%');
      const p = `$${params.length}`;
      return `(title ILIKE ${p} OR description ILIKE ${p} OR category ILIKE ${p} OR subject ILIKE ${p} OR creator ILIKE ${p})`;
    });
    where += ` AND (${ors.join(' OR ')})`;
  }
  if (phrases.length) {
    params.push(phrases.map((t) => '%' + likeEscape(t) + '%'));
    const p = `$${params.length}::text[]`;
    where += ` AND (title ILIKE ANY(${p}) OR description ILIKE ANY(${p}) OR category ILIKE ANY(${p}) OR subject ILIKE ANY(${p}) OR creator ILIKE ANY(${p}))`;
  }
  if (cursor)  { params.push(cursor);  where += ` AND id < $${params.length}`; }
  params.push(lim);

  const { rows } = await getPool().query(
    `SELECT * FROM reels ${where} ORDER BY id DESC LIMIT $${params.length}`, params
  );
  return { items: rows, nextCursor: rows.length === lim ? String(rows[rows.length - 1].id) : null };
}

/* Likes are per-user rows, so the count can't be inflated by tapping twice
   and survives the user reinstalling the app. `want` = true (like) / false
   (unlike) sets the state explicitly, so a phone that forgot its local like
   state can't accidentally remove a like; without it the like toggles. */
async function toggleLike(reelId, userId, want) {
  if (!HAS_DB) {
    const r = memoryReels.find((x) => String(x.id) === String(reelId));
    if (!r) throw new Error('not found');
    r._likers = r._likers || new Set();
    const liked = typeof want === 'boolean' ? want : !r._likers.has(userId);
    liked ? r._likers.add(userId) : r._likers.delete(userId);
    r.likes = r._likers.size;
    return { liked, likes: r.likes };
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT 1 FROM reels WHERE id=$1', [reelId]);
    if (!exists.rowCount) throw new Error('not found');
    const had = (await client.query(
      'SELECT 1 FROM reel_likes WHERE reel_id=$1 AND user_id=$2', [reelId, userId]
    )).rowCount > 0;
    const liked = typeof want === 'boolean' ? want : !had;
    if (liked && !had) await client.query('INSERT INTO reel_likes (reel_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [reelId, userId]);
    if (!liked && had) await client.query('DELETE FROM reel_likes WHERE reel_id=$1 AND user_id=$2', [reelId, userId]);
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

/* Who liked a reel, newest first, one page at a time (no cap). Returns
   account ids only; the server turns them into display names. */
async function listLikers(reelId, { limit = 30, cursor = null } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 30));
  if (!HAS_DB) {
    const r = memoryReels.find((x) => String(x.id) === String(reelId));
    if (!r) throw new Error('not found');
    const all = [...(r._likers || [])].reverse();
    const start = Math.max(0, Number(cursor) || 0);
    const page = all.slice(start, start + lim);
    return { users: page, total: all.length, nextCursor: start + lim < all.length ? String(start + lim) : null };
  }
  const exists = await getPool().query('SELECT likes FROM reels WHERE id=$1', [reelId]);
  if (!exists.rowCount) throw new Error('not found');
  const params = [reelId];
  let where = 'reel_id=$1';
  if (cursor) {
    const [ts, ...rest] = String(cursor).split('|');
    const user = rest.join('|');
    // Exact Postgres timestamp text (microseconds kept); anything else is ignored.
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/.test(ts || '')) {
      params.push(ts, user);
      where += ` AND (liked_at, user_id) < ($2::timestamptz, $3)`;
    }
  }
  params.push(lim);
  const { rows } = await getPool().query(
    `SELECT user_id, liked_at::text AS ts FROM reel_likes WHERE ${where} ORDER BY liked_at DESC, user_id DESC LIMIT $${params.length}`, params
  );
  const last = rows[rows.length - 1];
  return {
    users: rows.map((x) => x.user_id),
    total: Number(exists.rows[0].likes || 0),
    nextCursor: rows.length === lim ? `${last.ts}|${last.user_id}` : null,
  };
}

/* "Your activity": how many reels this account has liked and how many
   comments (incl. replies) it has posted - from the server, so it's right
   on every phone. */
async function activityCounts(userId) {
  const u = String(userId || '').toLowerCase();
  if (!u) return { likes: 0, comments: 0 };
  if (!HAS_DB) {
    let likes = 0, comments = 0;
    memoryReels.forEach((r) => { if (r._likers && r._likers.has(u)) likes++; });
    for (const arr of memoryComments.values()) comments += arr.filter((c) => String(c.user_id).toLowerCase() === u).length;
    return { likes, comments };
  }
  const { rows } = await getPool().query(
    `SELECT (SELECT COUNT(*)::int FROM reel_likes l JOIN reels r ON r.id = l.reel_id WHERE l.user_id=$1) AS likes,
            (SELECT COUNT(*)::int FROM reel_comments c JOIN reels r ON r.id = c.reel_id WHERE c.user_id=$1) AS comments`, [u]
  );
  return rows[0];
}

/* Which of these reels has this user liked? Lets the app show the red heart
   correctly on any phone, even after a reinstall. */
async function likedIds(userId, reelIds) {
  const ids = (reelIds || []).map(Number).filter(Number.isFinite);
  if (!userId || !ids.length) return new Set();
  if (!HAS_DB) {
    return new Set(memoryReels.filter((r) => r._likers && r._likers.has(userId) && ids.includes(Number(r.id))).map((r) => Number(r.id)));
  }
  const { rows } = await getPool().query(
    'SELECT reel_id FROM reel_likes WHERE user_id=$1 AND reel_id = ANY($2::bigint[])', [userId, ids]
  );
  return new Set(rows.map((r) => Number(r.reel_id)));
}

/* Account deletion: remove every like this user gave and fix the counts. */
async function deleteLikesByUser(userId) {
  if (!userId) return 0;
  if (!HAS_DB) {
    let n = 0;
    memoryReels.forEach((r) => { if (r._likers && r._likers.delete(userId)) { n++; r.likes = r._likers.size; } });
    return n;
  }
  const { rows } = await getPool().query('DELETE FROM reel_likes WHERE user_id=$1 RETURNING reel_id', [userId]);
  const touched = [...new Set(rows.map((r) => Number(r.reel_id)))];
  if (touched.length) {
    await getPool().query(
      `UPDATE reels SET likes = (SELECT COUNT(*) FROM reel_likes l WHERE l.reel_id = reels.id) WHERE id = ANY($1::bigint[])`, [touched]
    );
  }
  return rows.length;
}

/* A share is counted each time someone shares the reel (the server rate-
   limits repeats from the same person). Returns the new total. */
async function addShare(reelId) {
  if (!HAS_DB) {
    const r = memoryReels.find((x) => String(x.id) === String(reelId));
    if (!r) throw new Error('not found');
    r.share_count = (r.share_count || 0) + 1;
    return r.share_count;
  }
  const { rows } = await getPool().query(
    'UPDATE reels SET share_count = share_count + 1 WHERE id=$1 RETURNING share_count', [reelId]
  );
  if (!rows.length) throw new Error('not found');
  return rows[0].share_count;
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
const memoryComments = new Map();   // String(reelId) -> [{id,reel_id,parent_id,user_id,username,text,likes,created_at}]
const memoryCommentLikes = new Map(); // String(commentId) -> Set(userId)

/* Replies are one level deep, like Instagram: replying to a reply attaches
   it to the same top-level comment. A reply counts as a comment in the
   reel's comment total. */
async function addComment(reelId, userId, username, text, parentId = null, mentions = null) {
  const clean = String(text || '').trim().slice(0, MAX_COMMENT_LENGTH);
  if (!clean) throw new Error('Comment text is required');
  if (!userId) throw new Error('userId is required');

  if (!HAS_DB) {
    const reel = memoryReels.find((x) => String(x.id) === String(reelId));
    if (!reel) throw new Error('not found');
    const arr = memoryComments.get(String(reelId)) || [];
    let parent = null;
    if (parentId != null && parentId !== '') {
      const p = arr.find((c) => String(c.id) === String(parentId));
      if (!p) throw new Error('parent not found');
      parent = p.parent_id || p.id;
    }
    const row = {
      id: nextMemoryId(), reel_id: reelId, parent_id: parent, user_id: userId,
      username: username || userId, text: clean, likes: 0, created_at: new Date().toISOString(),
      mentions: mentions && mentions.length ? JSON.stringify(mentions) : null,
    };
    arr.push(row);
    memoryComments.set(String(reelId), arr);
    reel.comment_count = arr.length;
    row.comment_count = reel.comment_count;
    return row;
  }

  let parent = null;
  if (parentId != null && parentId !== '') {
    const { rows: pr } = await getPool().query(
      'SELECT id, parent_id FROM reel_comments WHERE id=$1 AND reel_id=$2', [parentId, reelId]
    );
    if (!pr.length) throw new Error('parent not found');
    parent = pr[0].parent_id || pr[0].id;
  }
  const upd = await getPool().query(
    'UPDATE reels SET comment_count = comment_count + 1 WHERE id=$1 RETURNING comment_count', [reelId]
  );
  if (!upd.rowCount) throw new Error('not found');
  const { rows } = await getPool().query(
    `INSERT INTO reel_comments (reel_id, parent_id, user_id, username, text, mentions) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [reelId, parent, userId, username || userId, clean, mentions && mentions.length ? JSON.stringify(mentions) : null]
  );
  rows[0].comment_count = upd.rows[0].comment_count;
  return rows[0];
}

/* Oldest-first (the app groups replies under their comment). */
async function listComments(reelId, { limit = 2000 } = {}) {
  const lim = Math.min(2000, Math.max(1, Number(limit) || 2000));

  if (!HAS_DB) {
    const arr = memoryComments.get(String(reelId)) || [];
    return arr.slice(-lim);
  }

  const { rows } = await getPool().query(
    `SELECT * FROM reel_comments WHERE reel_id=$1 ORDER BY id ASC LIMIT $2`, [reelId, lim]
  );
  return rows;
}

/* Heart on a comment: one per user, set (want=true/false) or toggle. */
async function likeComment(commentId, userId, want) {
  if (!HAS_DB) {
    let row = null;
    for (const arr of memoryComments.values()) { row = arr.find((c) => String(c.id) === String(commentId)); if (row) break; }
    if (!row) throw new Error('not found');
    const set = memoryCommentLikes.get(String(commentId)) || new Set();
    const liked = typeof want === 'boolean' ? want : !set.has(userId);
    liked ? set.add(userId) : set.delete(userId);
    memoryCommentLikes.set(String(commentId), set);
    row.likes = set.size;
    return { liked, likes: row.likes };
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT 1 FROM reel_comments WHERE id=$1', [commentId]);
    if (!exists.rowCount) throw new Error('not found');
    const had = (await client.query('SELECT 1 FROM comment_likes WHERE comment_id=$1 AND user_id=$2', [commentId, userId])).rowCount > 0;
    const liked = typeof want === 'boolean' ? want : !had;
    if (liked && !had) await client.query('INSERT INTO comment_likes (comment_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [commentId, userId]);
    if (!liked && had) await client.query('DELETE FROM comment_likes WHERE comment_id=$1 AND user_id=$2', [commentId, userId]);
    const { rows } = await client.query(
      'UPDATE reel_comments SET likes = (SELECT COUNT(*) FROM comment_likes WHERE comment_id=$1) WHERE id=$1 RETURNING likes', [commentId]
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

/* Which of these comments has this user hearted? */
async function likedCommentIds(userId, commentIds) {
  const ids = (commentIds || []).map(Number).filter(Number.isFinite);
  if (!userId || !ids.length) return new Set();
  if (!HAS_DB) return new Set(ids.filter((id) => (memoryCommentLikes.get(String(id)) || new Set()).has(userId)));
  const { rows } = await getPool().query(
    'SELECT comment_id FROM comment_likes WHERE user_id=$1 AND comment_id = ANY($2::bigint[])', [userId, ids]
  );
  return new Set(rows.map((r) => Number(r.comment_id)));
}

async function deleteCommentsForReel(reelId) {
  if (!HAS_DB) {
    (memoryComments.get(String(reelId)) || []).forEach((c) => memoryCommentLikes.delete(String(c.id)));
    memoryComments.delete(String(reelId));
    return;
  }
  await getPool().query('DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM reel_comments WHERE reel_id=$1)', [reelId]);
  await getPool().query('DELETE FROM reel_comments WHERE reel_id=$1', [reelId]);
}

/* Account deletion: removes every comment the user POSTED (anywhere), the
   replies under those comments, and every comment heart they gave; then
   fixes the affected counts. */
async function deleteCommentsByUser(userId) {
  if (!HAS_DB) {
    let removed = 0;
    for (const [key, arr] of memoryComments) {
      const gone = new Set(arr.filter((c) => c.user_id === userId).map((c) => String(c.id)));
      const kept = arr.filter((c) => !gone.has(String(c.id)) && !(c.parent_id && gone.has(String(c.parent_id))));
      arr.filter((c) => !kept.includes(c)).forEach((c) => memoryCommentLikes.delete(String(c.id)));
      removed += arr.length - kept.length;
      memoryComments.set(key, kept);
      const reel = memoryReels.find((x) => String(x.id) === key);
      if (reel) reel.comment_count = kept.length;
    }
    for (const [cid, set] of memoryCommentLikes) {
      if (set.delete(userId)) {
        for (const arr of memoryComments.values()) { const c = arr.find((x) => String(x.id) === cid); if (c) c.likes = set.size; }
      }
    }
    return removed;
  }
  const { rows } = await getPool().query(
    `DELETE FROM reel_comments WHERE user_id=$1
        OR parent_id IN (SELECT id FROM reel_comments WHERE user_id=$1)
     RETURNING id, reel_id`, [userId]
  );
  if (rows.length) {
    await getPool().query('DELETE FROM comment_likes WHERE comment_id = ANY($1::bigint[])', [rows.map((r) => Number(r.id))]);
  }
  const touched = [...new Set(rows.map((r) => Number(r.reel_id)))];
  if (touched.length) {
    await getPool().query(
      `UPDATE reels SET comment_count = (SELECT COUNT(*) FROM reel_comments c WHERE c.reel_id = reels.id)
       WHERE id = ANY($1::bigint[])`, [touched]
    );
  }
  const { rows: liked } = await getPool().query('DELETE FROM comment_likes WHERE user_id=$1 RETURNING comment_id', [userId]);
  const likedIds = [...new Set(liked.map((r) => Number(r.comment_id)))];
  if (likedIds.length) {
    await getPool().query(
      `UPDATE reel_comments SET likes = (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id = reel_comments.id)
       WHERE id = ANY($1::bigint[])`, [likedIds]
    );
  }
  return rows.length;
}

function getCommentSync(id) {
  for (const arr of memoryComments.values()) { const c = arr.find((x) => String(x.id) === String(id)); if (c) return c; }
  return null;
}
/* One comment (for reply notifications: who wrote the parent). */
async function getComment(id) {
  if (!HAS_DB) return getCommentSync(id);
  const { rows } = await getPool().query('SELECT * FROM reel_comments WHERE id=$1', [id]);
  return rows[0] || null;
}

function toClientComment(row) {
  let mentions = [];
  try { mentions = row.mentions ? JSON.parse(row.mentions) : []; } catch {}
  return {
    mentions: Array.isArray(mentions) ? mentions.map((h) => String(h).toLowerCase()) : [],
    id: Number(row.id), parentId: row.parent_id == null ? null : Number(row.parent_id),
    user: row.username || row.user_id, text: row.text, likes: Number(row.likes || 0), createdAt: row.created_at,
  };
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
    likes: Number(row.likes || 0),
    comments: Number(row.comment_count || 0),
    shares: Number(row.share_count || 0),
    // Public id of the uploader's account (for Follow). Null for very old reels.
    creatorId: row.owner_id ? require('./session-service').publicId(row.owner_id) : null,
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
/* Paged like the feed (no cap): returns one page plus the cursor for the
   next one, and the creator's total upload count for the profile header. */
async function listOwnReels(ownerId, handle, { limit = 30, cursor = null } = {}) {
  const owner = String(ownerId || '').trim().toLowerCase();
  const lim = Math.min(50, Math.max(1, Number(limit) || 30));
  if (!HAS_DB) {
    const all = memoryReels.filter((r) => (owner && r.owner_id === owner) || (!r.owner_id && handle && r.creator === handle));
    const rest = cursor ? all.filter((r) => Number(r.id) < Number(cursor)) : all;
    const page = rest.slice(0, lim);
    return { items: page, total: all.length, nextCursor: page.length === lim && rest.length > lim ? String(page[page.length - 1].id) : null };
  }
  const base = `status='published' AND (owner_id=$1 OR (owner_id IS NULL AND creator=$2))`;
  const params = [owner, handle || ''];
  let where = base;
  if (cursor) { params.push(cursor); where += ` AND id < $${params.length}`; }
  params.push(lim);
  const [{ rows }, count] = await Promise.all([
    getPool().query(`SELECT * FROM reels WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params),
    getPool().query(`SELECT COUNT(*)::int AS n FROM reels WHERE ${base}`, [owner, handle || '']),
  ]);
  return { items: rows, total: count.rows[0].n, nextCursor: rows.length === lim ? String(rows[rows.length - 1].id) : null };
}

module.exports = {
  deleteOwnReel, deleteAllReelsByOwner, listOwnReels,
  getComment, activityCounts, likedIds, addShare, deleteLikesByUser, likeComment, likedCommentIds, listLikers,
  initSchema, storeVideo, readVideo, createReel, listReels, getReel, getReelsByIds,
  toggleLike, incrementViews, deleteReel, deleteAllReelsByCreator, toClientReel,
  storeImage, setAvatar, getAvatars, deleteAvatar,
  addComment, listComments, deleteCommentsForReel, deleteCommentsByUser, toClientComment,
  HAS_R2, HAS_DB,
};
