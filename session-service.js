/*
 * Proof-of-identity for sensitive requests.
 *
 * Before this, the server trusted the app blindly: anyone calling the API
 * directly could reset any user's password (no code needed), delete any
 * account, or delete any reel. Two small mechanisms close that:
 *
 *  1. Verification tickets. /api/verify-otp hands back a one-time ticket
 *     (15 minutes) only after a correct emailed code. Password reset
 *     requires that ticket for the same email.
 *
 *  2. Session tokens. /api/login and /api/signup return a signed token
 *     (HMAC, 180 days). Deleting the account or changing the profile photo
 *     requires it as "Authorization: Bearer <token>" for that same email.
 *
 * Set AUTH_SECRET on Render to a long random string. Without it a secret is
 * derived from other server secrets so tokens still survive restarts.
 */
const crypto = require('crypto');

const SECRET = process.env.AUTH_SECRET
  || crypto.createHash('sha256').update(
    `eduinsta|${process.env.DATABASE_URL || ''}|${process.env.RAZORPAY_KEY_SECRET || ''}|${process.env.OWNER_TOKEN || ''}`
  ).digest('hex');
if (!process.env.AUTH_SECRET) console.warn('⚠️  AUTH_SECRET not set — using a derived secret. Set AUTH_SECRET on Render.');

const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const TICKET_TTL_MS = 15 * 60 * 1000;

const norm = (e) => String(e || '').trim().toLowerCase();
const b64u = (s) => Buffer.from(s).toString('base64url');
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

function issueToken(email) {
  const payload = `${b64u(norm(email))}.${Date.now() + TOKEN_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

/* Returns the email the token belongs to, or null. */
function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  if (Date.now() > Number(parts[1])) return null;
  try { return Buffer.from(parts[0], 'base64url').toString(); } catch { return null; }
}

function tokenFromReq(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/* true when the request carries a valid session token for `email`. */
function isSignedInAs(req, email) {
  const who = verifyToken(tokenFromReq(req));
  return !!who && who === norm(email);
}

const tickets = new Map();   // ticket -> { target, exp }
function issueTicket(target) {
  const t = crypto.randomBytes(24).toString('hex');
  tickets.set(t, { target: norm(target), exp: Date.now() + TICKET_TTL_MS });
  if (tickets.size > 5000) {
    const now = Date.now();
    for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k);
  }
  return t;
}
/* One-time use: a valid ticket is consumed. */
function consumeTicket(ticket, target) {
  const rec = tickets.get(String(ticket || ''));
  if (!rec) return false;
  tickets.delete(String(ticket));
  return rec.exp > Date.now() && rec.target === norm(target);
}

module.exports = { issueToken, verifyToken, isSignedInAs, issueTicket, consumeTicket };
