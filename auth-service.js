/**
 * Real, server-side accounts.
 *
 * WHY THIS EXISTS
 * ----------------
 * Before this file, "signing up" only ever wrote to the BROWSER's local
 * storage inside the app's WebView. That storage is wiped whenever the app
 * is uninstalled (or its data is cleared, or the user switches devices) —
 * so a real account with a real password would simply vanish, and "Log in"
 * would fail with "No account found on this device yet" even though the
 * user never asked to delete anything.
 *
 * This module gives Gyanora actual server-side accounts: email + a
 * securely hashed password, persisted in Postgres (or an in-memory map in
 * MEMORY MODE, same fallback pattern as reels-service.js and
 * diagnostics-service.js). A reinstall no longer loses your login.
 *
 * PASSWORD HASHING
 * -----------------
 * Uses Node's built-in crypto.scrypt (a proper, slow, salted key-derivation
 * function) rather than a plain hash — this avoids adding a new npm
 * dependency (bcrypt) that would need its own native build step in CI, and
 * scrypt is already the right tool for the job: it's deliberately slow to
 * brute-force, unlike a fast hash like SHA-256.
 */

const crypto = require('crypto');

const HAS_DB = !!process.env.DATABASE_URL;
let pool = null;
function getPool() {
  if (pool || !HAS_DB) return pool;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  return pool;
}

async function initSchema() {
  if (!HAS_DB) {
    console.warn('⚠️  MEMORY MODE: no DATABASE_URL. Accounts are lost on restart — every user would need to sign up again after a redeploy. Set DATABASE_URL for production.');
    return;
  }
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS users (
      email          TEXT PRIMARY KEY,
      name           TEXT,
      phone          TEXT,
      password_hash  TEXT NOT NULL,
      password_salt  TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

const memoryUsers = new Map();   // normalized email -> {email,name,phone,hash,salt}

function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
}

async function getUser(email) {
  const key = normEmail(email);
  if (!key) return null;

  if (!HAS_DB) return memoryUsers.get(key) || null;

  const { rows } = await getPool().query('SELECT * FROM users WHERE email=$1', [key]);
  if (!rows.length) return null;
  const r = rows[0];
  return { email: r.email, name: r.name, phone: r.phone, hash: r.password_hash, salt: r.password_salt };
}

async function userExists(email) {
  return !!(await getUser(email));
}

/* Used both for a normal signup AND to silently "migrate" an existing
   pre-this-update local-only account onto the server the first time it
   successfully logs in from its original device (see performLogin in
   index.html) — so nobody who signed up before this feature shipped gets
   locked out either. ON CONFLICT keeps that migration idempotent. */
async function createUser({ email, name, phone, password }) {
  const key = normEmail(email);
  if (!key || !password) throw new Error('email and password are required');
  const salt = makeSalt();
  const hash = hashPassword(password, salt);

  if (!HAS_DB) {
    memoryUsers.set(key, { email: key, name: name || '', phone: phone || null, hash, salt });
    return { ok: true };
  }

  await getPool().query(
    `INSERT INTO users (email, name, phone, password_hash, password_salt)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (email) DO NOTHING`,
    [key, name || '', phone || null, hash, salt]
  );
  return { ok: true };
}

/* notFound vs a plain ok:false distinguishes "this email was never
   registered" from "wrong password" - the server route uses that to
   answer 404 vs 401, and the client uses that to know whether it's safe to
   fall back to a local-only check (see performLogin in index.html). */
async function verifyPassword(email, password) {
  const user = await getUser(email);
  if (!user) return { ok: false, notFound: true, error: 'No account found with this email.' };

  const attempt = Buffer.from(hashPassword(password, user.salt));
  const stored = Buffer.from(user.hash);
  const match = attempt.length === stored.length && crypto.timingSafeEqual(attempt, stored);
  if (!match) return { ok: false, error: 'Incorrect email or password.' };

  return { ok: true, name: user.name, phone: user.phone };
}

async function updatePassword(email, newPassword) {
  const key = normEmail(email);
  const salt = makeSalt();
  const hash = hashPassword(newPassword, salt);

  if (!HAS_DB) {
    const existing = memoryUsers.get(key);
    if (!existing) return { ok: false, error: 'No account found with this email.' };
    existing.hash = hash; existing.salt = salt;
    return { ok: true };
  }

  const { rowCount } = await getPool().query(
    'UPDATE users SET password_hash=$2, password_salt=$3, updated_at=now() WHERE email=$1',
    [key, hash, salt]
  );
  return rowCount ? { ok: true } : { ok: false, error: 'No account found with this email.' };
}

async function updateProfile(email, { name, phone } = {}) {
  const key = normEmail(email);
  if (!HAS_DB) {
    const existing = memoryUsers.get(key);
    if (!existing) return { ok: false };
    if (name !== undefined) existing.name = name;
    if (phone !== undefined) existing.phone = phone;
    return { ok: true };
  }
  await getPool().query(
    `UPDATE users SET name=COALESCE($2,name), phone=COALESCE($3,phone), updated_at=now() WHERE email=$1`,
    [key, name ?? null, phone ?? null]
  );
  return { ok: true };
}

async function deleteUser(email) {
  const key = normEmail(email);
  if (!HAS_DB) { memoryUsers.delete(key); return; }
  await getPool().query('DELETE FROM users WHERE email=$1', [key]);
}

module.exports = {
  initSchema, createUser, verifyPassword, updatePassword, updateProfile, deleteUser, userExists, getUser,
  HAS_DB,
};
