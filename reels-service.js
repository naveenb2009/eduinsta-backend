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
    return { key, url: `/api/video/${encodeURIComponent(key)}` };
  }

  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await getS3().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType || 'video/mp4',
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  // Serve through the public R2/CDN domain if configured, else proxy via us.
  const base = process.env.R2_PUBLIC_URL;
  return { key, url: base ? `${base.replace(/\/$/, '')}/${key}` : `/api/video/${encodeURIComponent(key)}` };
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

    CREATE TABLE IF NOT EXISTS reel_likes (
      reel_id  BIGINT NOT NULL,
      user_id  TEXT   NOT NULL,
      PRIMARY KEY (reel_id, user_id)
    );
  `);
  if (!HAS_R2) console.warn('⚠️  No R2 configured — videos are held in memory and lost on restart.');
}

async function createReel({ creator, title, description, category, subject, videoKey, videoUrl }) {
  if (!HAS_DB) {
    const row = {
      id: nextMemoryId(), creator, title, description, category, subject,
      video_key: videoKey, video_url: videoUrl, status: 'published',
      likes: 0, views: 0, created_at: new Date().toISOString(),
    };
    memoryReels.unshift(row);
    return row;
  }
  const { rows } = await getPool().query(
    `INSERT INTO reels (creator,title,description,category,subject,video_key,video_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [creator, title, description || '', category || '', subject || '', videoKey, videoUrl]
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
    return true;
  }
  const { rows } = await getPool().query(
    'DELETE FROM reels WHERE id=$1 AND creator=$2 RETURNING video_key', [reelId, creator]
  );
  if (!rows.length) return false;
  await deleteVideo(rows[0].video_key).catch(() => {});
  return true;
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

module.exports = {
  initSchema, storeVideo, readVideo, createReel, listReels,
  toggleLike, incrementViews, deleteReel, toClientReel,
  HAS_R2, HAS_DB,
};
