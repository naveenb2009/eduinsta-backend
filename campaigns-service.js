/*
 * Direct ad campaigns ("Sponsored" reels in the feed), sold by the owner.
 *
 * Flow: a business pays the owner directly (UPI/bank), the owner adds the
 * campaign from the app's owner screen, and it is stored here so EVERY free
 * user sees it for the booked days. Views and clicks are counted so the owner
 * can report results to the advertiser.
 *
 * Postgres when DATABASE_URL is set, in-memory otherwise (local testing).
 */
const HAS_DB = !!process.env.DATABASE_URL;

let pool = null;
function getPool() {
  if (pool || !HAS_DB) return pool;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  return pool;
}

const memory = [];
let memId = 0;

async function initSchema() {
  if (!HAS_DB) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id           BIGSERIAL PRIMARY KEY,
      sponsor      TEXT NOT NULL,
      headline     TEXT NOT NULL,
      cta          TEXT NOT NULL,
      link_url     TEXT,
      start_at     BIGINT NOT NULL,
      end_at       BIGINT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active',
      price        INTEGER,
      payment_note TEXT,
      impressions  INTEGER NOT NULL DEFAULT 0,
      clicks       INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

const toClient = (r) => ({
  id: Number(r.id), sponsor: r.sponsor, headline: r.headline, cta: r.cta, link: r.link_url || null,
  startAt: Number(r.start_at), endAt: Number(r.end_at), status: r.status,
  price: r.price == null ? null : Number(r.price), paymentNote: r.payment_note || '',
  impressions: Number(r.impressions || 0), clicks: Number(r.clicks || 0),
});
/* What every app user receives: nothing about price or payment. */
const toPublic = (c) => ({ id: c.id, sponsor: c.sponsor, headline: c.headline, cta: c.cta, link: c.link });

const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function validate(input) {
  const sponsor = clean(input.sponsor, 60);
  const headline = clean(input.headline, 120);
  const cta = clean(input.cta, 24) || 'Learn more';
  let link = clean(input.link, 500);
  const days = Math.round(Number(input.days));
  if (!sponsor || !headline) return { error: 'Sponsor name and headline are required' };
  if (!Number.isFinite(days) || days < 1 || days > 365) return { error: 'Duration must be 1–365 days' };
  if (link) {
    if (!/^https?:\/\//i.test(link)) link = 'https://' + link;
    try { const u = new URL(link); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { return { error: 'The link is not a valid web address' }; }
  }
  const price = input.price === '' || input.price == null ? null : Math.max(0, Math.round(Number(input.price)));
  if (price != null && !Number.isFinite(price)) return { error: 'Price must be a number' };
  const startAt = Date.now();
  return { value: { sponsor, headline, cta, link: link || null, startAt, endAt: startAt + days * 86400000, price, paymentNote: clean(input.paymentNote, 200) } };
}

async function create(input) {
  const v = validate(input || {});
  if (v.error) return v;
  const c = v.value;
  if (!HAS_DB) {
    const row = { id: ++memId, sponsor: c.sponsor, headline: c.headline, cta: c.cta, link_url: c.link, start_at: c.startAt, end_at: c.endAt, status: 'active', price: c.price, payment_note: c.paymentNote, impressions: 0, clicks: 0 };
    memory.unshift(row);
    return { campaign: toClient(row) };
  }
  const { rows } = await getPool().query(
    `INSERT INTO campaigns (sponsor, headline, cta, link_url, start_at, end_at, price, payment_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [c.sponsor, c.headline, c.cta, c.link, c.startAt, c.endAt, c.price, c.paymentNote]
  );
  return { campaign: toClient(rows[0]) };
}

async function listAll() {
  if (!HAS_DB) return memory.map(toClient);
  const { rows } = await getPool().query('SELECT * FROM campaigns ORDER BY id DESC LIMIT 200');
  return rows.map(toClient);
}

/* Running right now: active status and inside its booked dates. */
async function listActive() {
  const now = Date.now();
  if (!HAS_DB) return memory.filter((r) => r.status === 'active' && r.start_at <= now && r.end_at > now).map(toClient).map(toPublic);
  const { rows } = await getPool().query(
    `SELECT * FROM campaigns WHERE status='active' AND start_at <= $1 AND end_at > $1 ORDER BY id DESC LIMIT 20`, [now]
  );
  return rows.map(toClient).map(toPublic);
}

async function bump(id, field) {
  if (field !== 'impressions' && field !== 'clicks') return false;
  if (!HAS_DB) { const r = memory.find((x) => String(x.id) === String(id)); if (!r) return false; r[field]++; return true; }
  const { rowCount } = await getPool().query(`UPDATE campaigns SET ${field} = ${field} + 1 WHERE id=$1`, [id]);
  return rowCount > 0;
}

async function end(id) {
  const now = Date.now();
  if (!HAS_DB) { const r = memory.find((x) => String(x.id) === String(id)); if (!r) return false; r.status = 'ended'; r.end_at = Math.min(r.end_at, now); return true; }
  const { rowCount } = await getPool().query(`UPDATE campaigns SET status='ended', end_at=LEAST(end_at,$2) WHERE id=$1`, [id, now]);
  return rowCount > 0;
}

async function remove(id) {
  if (!HAS_DB) { const i = memory.findIndex((x) => String(x.id) === String(id)); if (i < 0) return false; memory.splice(i, 1); return true; }
  const { rowCount } = await getPool().query('DELETE FROM campaigns WHERE id=$1', [id]);
  return rowCount > 0;
}

module.exports = { initSchema, create, listAll, listActive, bump, end, remove, HAS_DB };
