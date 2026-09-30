/*
 * Premium subscription records (one row per user), written by the RevenueCat
 * webhook and read by /api/subscription/:userId.
 *
 * These used to live only in memory (a Map in server.js), so every Render
 * restart - which on the free plan happens after ~15 minutes idle - forgot
 * who had paid, and paying users saw ads again until their next renewal.
 * With DATABASE_URL set they are stored in Postgres; without it (local
 * testing) the old in-memory behaviour is kept.
 */
const HAS_DB = !!process.env.DATABASE_URL;

let pool = null;
function getPool() {
  if (pool || !HAS_DB) return pool;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  return pool;
}

const memory = new Map();

async function initSchema() {
  if (!HAS_DB) {
    console.warn('⚠️  MEMORY MODE: no DATABASE_URL. Premium subscriptions are lost on restart.');
    return;
  }
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id     TEXT PRIMARY KEY,
      status      TEXT NOT NULL,
      expires_at  BIGINT,
      payment_id  TEXT,
      amount      INTEGER,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function get(userId) {
  if (!userId) return null;
  if (!HAS_DB) return memory.get(userId) || null;
  const { rows } = await getPool().query(
    'SELECT status, expires_at, payment_id, amount FROM subscriptions WHERE user_id=$1', [userId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { status: r.status, expiresAt: r.expires_at == null ? null : Number(r.expires_at), paymentId: r.payment_id, amount: r.amount };
}

async function set(userId, { status, expiresAt, paymentId, amount }) {
  if (!userId) return;
  if (!HAS_DB) { memory.set(userId, { status, expiresAt, paymentId, amount }); return; }
  await getPool().query(
    `INSERT INTO subscriptions (user_id, status, expires_at, payment_id, amount, updated_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (user_id) DO UPDATE SET status=EXCLUDED.status, expires_at=EXCLUDED.expires_at,
       payment_id=EXCLUDED.payment_id, amount=EXCLUDED.amount, updated_at=now()`,
    [userId, status, expiresAt == null ? null : Math.round(expiresAt), paymentId || null, amount == null ? null : amount]
  );
}

async function setStatus(userId, status) {
  if (!userId) return;
  if (!HAS_DB) { const s = memory.get(userId); if (s) s.status = status; return; }
  await getPool().query('UPDATE subscriptions SET status=$2, updated_at=now() WHERE user_id=$1', [userId, status]);
}

async function remove(userId) {
  if (!userId) return;
  if (!HAS_DB) { memory.delete(userId); return; }
  await getPool().query('DELETE FROM subscriptions WHERE user_id=$1', [userId]);
}

module.exports = { initSchema, get, set, setStatus, remove, HAS_DB };
