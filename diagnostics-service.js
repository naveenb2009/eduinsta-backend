/**
 * Lightweight crash / diagnostics / performance logging.
 *
 * WHY THIS EXISTS
 * ----------------
 * Play Console's Data Safety form asks whether the app collects "Crash
 * logs", "Diagnostics" and "Other app performance data". This is what
 * makes that answer actually true, without pulling in Firebase Crashlytics
 * (a whole extra native SDK, google-services.json, Gradle plugin, and a
 * Firebase project to set up and maintain).
 *
 * The client (index.html) catches its own JS errors and unhandled promise
 * rejections, times a few key operations, and POSTs short reports here.
 * This module just stores them (Postgres when available, otherwise an
 * in-memory ring buffer) and lets you read them back.
 *
 * This is NOT a replacement for a real crash dashboard — it's the minimum
 * that's honest AND useful for a solo developer. It only sees JS-level
 * problems inside the WebView, not low-level native crashes outside it
 * (those are rare in a Capacitor app and would need Crashlytics to catch).
 */

const MAX_MEMORY_EVENTS = 500;   // ring buffer size when there's no database
const MAX_MESSAGE_LEN = 500;
const MAX_STACK_LEN = 4000;
const MAX_CONTEXT_LEN = 2000;
const VALID_TYPES = new Set(['crash', 'error', 'performance', 'report']);

const HAS_DB = !!process.env.DATABASE_URL;
let pool = null;
function getPool() {
  if (pool || !HAS_DB) return pool;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  return pool;
}

const memoryEvents = [];   // newest last; trimmed to MAX_MEMORY_EVENTS
let __idSeq = 0;

async function initSchema() {
  if (!HAS_DB) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS diagnostics (
      id           BIGSERIAL PRIMARY KEY,
      type         TEXT NOT NULL,
      message      TEXT,
      stack        TEXT,
      context      TEXT,
      user_id      TEXT,
      app_version  TEXT,
      platform     TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS diagnostics_created_idx ON diagnostics (created_at DESC);
  `);
}

/* Simple per-source rate limit so a runaway client-side error loop can't
   flood storage or the logs — mirrors the approach in otp-service.js. */
const rateLog = new Map();   // source -> [timestamps]
const MAX_PER_WINDOW = 30;
const WINDOW_MS = 5 * 60 * 1000;
function allowed(source) {
  const now = Date.now();
  const hits = (rateLog.get(source) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) return false;
  hits.push(now);
  rateLog.set(source, hits);
  return true;
}

async function logEvent({ type, message, stack, context, userId, appVersion, platform }) {
  if (!VALID_TYPES.has(type)) throw new Error('Invalid diagnostics type');
  const source = userId || 'anonymous';
  if (!allowed(source)) return { ok: false, throttled: true };

  const row = {
    type,
    message: String(message || '').slice(0, MAX_MESSAGE_LEN),
    stack: stack ? String(stack).slice(0, MAX_STACK_LEN) : null,
    context: context ? String(typeof context === 'string' ? context : JSON.stringify(context)).slice(0, MAX_CONTEXT_LEN) : null,
    user_id: userId || null,
    app_version: appVersion || null,
    platform: platform || null,
  };

  // Also goes to Render's own logs -- the fastest way to notice a crash
  // spike without opening anything extra.
  if (type === 'crash') console.error(`[diagnostics] CRASH ${row.user_id || ''}: ${row.message}`);
  if (type === 'report') console.warn(`[report] ${row.user_id || 'anonymous'}: ${row.message}`);

  if (!HAS_DB) {
    memoryEvents.push({ id: ++__idSeq, ...row, created_at: new Date().toISOString() });
    if (memoryEvents.length > MAX_MEMORY_EVENTS) memoryEvents.splice(0, memoryEvents.length - MAX_MEMORY_EVENTS);
    return { ok: true };
  }

  await getPool().query(
    `INSERT INTO diagnostics (type, message, stack, context, user_id, app_version, platform)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [row.type, row.message, row.stack, row.context, row.user_id, row.app_version, row.platform]
  );
  return { ok: true };
}

async function listEvents({ limit = 100, type = null } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));

  if (!HAS_DB) {
    let items = memoryEvents.slice().reverse();
    if (type) items = items.filter((e) => e.type === type);
    return items.slice(0, lim);
  }

  const params = [];
  let where = '';
  if (type) { params.push(type); where = `WHERE type = $${params.length}`; }
  params.push(lim);
  const { rows } = await getPool().query(
    `SELECT * FROM diagnostics ${where} ORDER BY id DESC LIMIT $${params.length}`, params
  );
  return rows;
}

module.exports = { initSchema, logEvent, listEvents, HAS_DB };
