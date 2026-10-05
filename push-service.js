/*
 * Push notifications to phones (Firebase Cloud Messaging, HTTP v1 API).
 *
 * Switched on by ONE Render environment variable:
 *   FCM_SERVICE_ACCOUNT = the Firebase service-account JSON key (paste the
 *                         whole JSON, or the same JSON base64-encoded)
 * Without it nothing is sent and everything else works as before.
 *
 * Each phone registers its push token for the signed-in account
 * (push_tokens). A notification is sent only if that person hasn't turned
 * the category off in Settings > Notifications (push_prefs). Tokens that
 * Firebase reports as no longer valid (app uninstalled) are deleted.
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
const memTokens = new Map();   // token -> pid
const memPrefs = new Map();    // pid -> {follower,comment,security}
const sentLog = [];            // last sends (for tests / diagnostics)

function serviceAccount() {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const txt = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(txt);
    return j.client_email && j.private_key && j.project_id ? j : null;
  } catch { return null; }
}
const isConfigured = () => !!serviceAccount();

async function initSchema() {
  if (!HAS_DB) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      token      TEXT PRIMARY KEY,
      pid        TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS push_tokens_pid_idx ON push_tokens (pid);
    CREATE TABLE IF NOT EXISTS push_prefs (
      pid      TEXT PRIMARY KEY,
      follower BOOLEAN NOT NULL DEFAULT true,
      comment  BOOLEAN NOT NULL DEFAULT true,
      security BOOLEAN NOT NULL DEFAULT true
    );
  `);
}

/* A phone's token now belongs to this account (a phone has one account at a time). */
async function register(pid, token) {
  const t = String(token || '').slice(0, 4096);
  if (!pid || t.length < 20) return false;
  if (!HAS_DB) { memTokens.set(t, pid); return true; }
  await getPool().query(
    `INSERT INTO push_tokens (token, pid) VALUES ($1,$2) ON CONFLICT (token) DO UPDATE SET pid=$2, updated_at=now()`, [t, pid]
  );
  return true;
}
async function unregister(token) {
  const t = String(token || '');
  if (!HAS_DB) { memTokens.delete(t); return; }
  await getPool().query('DELETE FROM push_tokens WHERE token=$1', [t]);
}
async function setPrefs(pid, { follower, comment, security } = {}) {
  if (!pid) return;
  const b = (v) => (typeof v === 'boolean' ? v : null);
  if (!HAS_DB) {
    const cur = memPrefs.get(pid) || { follower: true, comment: true, security: true };
    for (const [k, v] of Object.entries({ follower, comment, security })) if (typeof v === 'boolean') cur[k] = v;
    memPrefs.set(pid, cur); return;
  }
  await getPool().query(
    `INSERT INTO push_prefs (pid, follower, comment, security) VALUES ($1, COALESCE($2,true), COALESCE($3,true), COALESCE($4,true))
     ON CONFLICT (pid) DO UPDATE SET follower=COALESCE($2,push_prefs.follower), comment=COALESCE($3,push_prefs.comment), security=COALESCE($4,push_prefs.security)`,
    [pid, b(follower), b(comment), b(security)]
  );
}
async function tokensFor(pid) {
  if (!HAS_DB) return [...memTokens.entries()].filter(([, p]) => p === pid).map(([t]) => t);
  const { rows } = await getPool().query('SELECT token FROM push_tokens WHERE pid=$1 ORDER BY updated_at DESC LIMIT 10', [pid]);
  return rows.map((r) => r.token);
}
async function prefsFor(pid) {
  if (!HAS_DB) return memPrefs.get(pid) || { follower: true, comment: true, security: true };
  const { rows } = await getPool().query('SELECT follower, comment, security FROM push_prefs WHERE pid=$1', [pid]);
  return rows[0] || { follower: true, comment: true, security: true };
}
async function removeAccount(pid) {
  if (!HAS_DB) { for (const [t, p] of memTokens) if (p === pid) memTokens.delete(t); memPrefs.delete(pid); return; }
  await getPool().query('DELETE FROM push_tokens WHERE pid=$1', [pid]);
  await getPool().query('DELETE FROM push_prefs WHERE pid=$1', [pid]);
}

/* ---- Google OAuth access token for FCM (signed JWT, cached ~50 min) ---- */
let cachedToken = null, cachedUntil = 0;
const b64u = (x) => Buffer.from(x).toString('base64url');
async function accessToken(sa) {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error('FCM auth failed: ' + (d.error_description || d.error || res.status));
  cachedToken = d.access_token; cachedUntil = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

const TITLES = { follow: 'New follower', mention: 'You were mentioned', reply: 'New reply', comment: 'New comment on your reel', login: 'New sign-in' };
const CATEGORY = { follow: 'follower', mention: 'comment', reply: 'comment', comment: 'comment', login: 'security' };

/* Send one notification to every phone of this person (if allowed). */
async function send(pid, type, text, reelId = null) {
  try {
    const prefs = await prefsFor(pid);
    const cat = CATEGORY[type];
    if (cat && prefs[cat] === false) return 0;
    const tokens = await tokensFor(pid);
    if (!tokens.length) return 0;
    const title = TITLES[type] || 'Gyanora';
    sentLog.push({ pid, type, title, body: text, tokens: tokens.length, at: Date.now() }); if (sentLog.length > 200) sentLog.shift();
    const sa = serviceAccount();
    if (!sa) return 0;
    const at = await accessToken(sa);
    let sent = 0;
    for (const token of tokens) {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: {
          token,
          notification: { title, body: String(text || '').slice(0, 180) },
          data: { type: String(type), reelId: reelId == null ? '' : String(reelId) },
          android: { priority: 'high', notification: { channel_id: 'eduinsta' } },
        } }),
      });
      if (res.ok) { sent++; continue; }
      const body = await res.text();
      if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(body)) await unregister(token).catch(() => {});
      else console.warn('FCM send failed:', res.status, body.slice(0, 200));
    }
    return sent;
  } catch (err) {
    console.warn('push send failed:', err.message);
    return 0;
  }
}

module.exports = { initSchema, register, unregister, setPrefs, send, removeAccount, isConfigured, sentLog };
