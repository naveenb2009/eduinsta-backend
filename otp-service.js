/**
 * Real OTP delivery — email and SMS.
 *
 * WHY THIS CANNOT LIVE IN THE HTML FILE
 * ------------------------------------
 * Sending mail or SMS needs a provider API key. Anything in index.html is
 * readable by every user — they could open devtools, copy your key, and send
 * mail or SMS at your expense (SMS costs real money per message). Providers
 * also block browser-to-API calls outright for this reason.
 *
 * So OTP delivery MUST happen on a server. That's this file.
 *
 * The generated code NEVER goes back to the browser. The browser only gets
 * "sent: true". Verification happens here too, so the code can't be read out
 * of the page or bypassed by editing localStorage.
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');

const OTP_TTL_MS = 5 * 60 * 1000;   // code valid 5 minutes
const MAX_ATTEMPTS = 5;             // wrong guesses before the code dies
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_PER_HOUR = 5;             // per target, stops abuse / bill shock

/* In-memory store. Fine for one server; use Redis if you run more than one. */
const otpStore = new Map();   // target -> { hash, expiresAt, attempts, sentAt }
const rateLog = new Map();    // target -> [timestamps]

/* Store a HASH of the code, never the code itself. If your database or logs
   ever leak, the codes in them are useless. */
function hashCode(code, target) {
  return crypto.createHmac('sha256', process.env.OTP_SECRET || 'dev-secret')
    .update(`${target}:${code}`)
    .digest('hex');
}

function generateCode() {
  // crypto.randomInt is cryptographically secure; Math.random() is NOT and
  // must never be used to generate a security token.
  return String(crypto.randomInt(100000, 1000000));
}

/* ---------------- Email transport ----------------
   IMPORTANT: many hosts (including Render's free tier) BLOCK outbound SMTP
   ports 25/465/587 to prevent spam abuse. Gmail SMTP will fail there with
   "Connection timeout" no matter how correct your credentials are.

   So we prefer HTTP email APIs, which go over normal HTTPS (port 443) and
   work on every host. SMTP is kept only as a fallback for environments that
   allow it (a VPS, or local development).

   Provider is chosen by whichever key you set, in this order:
     1. BREVO_API_KEY   - 300 emails/day free, no domain needed. Easiest start.
     2. RESEND_API_KEY  - 3,000/month free; free tier can only send to your own
                          address until you verify a domain.
     3. SMTP_*          - only if your host permits SMTP.                     */

function otpEmailHtml(code) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
      <h2 style="color:#0f766e;margin:0 0 4px">EduInsta</h2>
      <p style="color:#555">Your verification code is:</p>
      <div style="font-size:34px;font-weight:800;letter-spacing:.2em;color:#0f766e;
                  background:#f2fbf9;border-radius:12px;padding:16px;text-align:center">${code}</div>
      <p style="color:#777;font-size:13px">This code expires in 5 minutes.</p>
      <p style="color:#999;font-size:12px">If you didn't request this, you can ignore this email.</p>
    </div>`;
}

const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER || 'onboarding@resend.dev';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'EduInsta';

async function sendViaBrevo(to, code) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      to: [{ email: to }],
      subject: `${code} is your EduInsta verification code`,
      htmlContent: otpEmailHtml(code),
    }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
}

async function sendViaResend(to, code) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: `${code} is your EduInsta verification code`,
      html: otpEmailHtml(code),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

let mailer = null;
function getMailer() {
  if (mailer) return mailer;
  if (!process.env.SMTP_HOST) return null;
  const nodemailer = require('nodemailer');
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
  });
  return mailer;
}

async function sendViaSmtp(to, code) {
  const transport = getMailer();
  if (!transport) throw new Error('No email provider configured');
  await transport.sendMail({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to,
    subject: `${code} is your EduInsta verification code`,
    text: `Your EduInsta verification code is ${code}. It expires in 5 minutes.`,
    html: otpEmailHtml(code),
  });
}

async function sendEmailOtp(to, code) {
  if (process.env.BREVO_API_KEY) return sendViaBrevo(to, code);
  if (process.env.RESEND_API_KEY) return sendViaResend(to, code);
  if (process.env.SMTP_HOST) return sendViaSmtp(to, code);
  throw new Error('No email provider configured — set BREVO_API_KEY (recommended on Render)');
}

/* ---------------- SMS transport ----------------
   Default here is MSG91 (widely used in India). Twilio works too — swap the
   fetch call. NOTE: sending SMS to Indian numbers requires DLT registration
   with TRAI plus an approved template; see OTP_SETUP.md. Email has no such
   requirement, which is why email is the recommended starting point. */
async function sendSmsOtp(phone, code) {
  if (!process.env.MSG91_AUTH_KEY) throw new Error('SMS not configured');
  const res = await fetch('https://control.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authkey: process.env.MSG91_AUTH_KEY,
    },
    body: JSON.stringify({
      template_id: process.env.MSG91_TEMPLATE_ID,
      mobile: phone.replace(/\D/g, ''),
      otp: code,
    }),
  });
  if (!res.ok) throw new Error('SMS provider rejected the request');
}

/* ---------------- Rate limiting ---------------- */
function checkRateLimit(target) {
  const now = Date.now();
  const hits = (rateLog.get(target) || []).filter((t) => now - t < 3600000);
  if (hits.length >= MAX_PER_HOUR) {
    return { ok: false, error: 'Too many codes requested. Try again in an hour.' };
  }
  const existing = otpStore.get(target);
  if (existing && now - existing.sentAt < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.sentAt)) / 1000);
    return { ok: false, error: `Please wait ${wait}s before requesting another code.` };
  }
  hits.push(now);
  rateLog.set(target, hits);
  return { ok: true };
}

/* ---------------- Public API ---------------- */
async function requestOtp(target, channel) {
  const limit = checkRateLimit(target);
  if (!limit.ok) return limit;

  const code = generateCode();
  otpStore.set(target, {
    hash: hashCode(code, target),
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
    sentAt: Date.now(),
  });

  try {
    if (channel === 'sms') await sendSmsOtp(target, code);
    else await sendEmailOtp(target, code);
  } catch (err) {
    otpStore.delete(target);
    console.error('OTP send failed:', err.message);
    return { ok: false, error: 'Could not send the code. Please try again.' };
  }

  // The code is deliberately NOT returned to the caller.
  return { ok: true, sent: true, expiresInSeconds: OTP_TTL_MS / 1000 };
}

function verifyOtp(target, code) {
  const rec = otpStore.get(target);
  if (!rec) return { ok: false, error: 'No code was requested. Please request a new one.' };
  if (Date.now() > rec.expiresAt) {
    otpStore.delete(target);
    return { ok: false, error: 'This code has expired. Please request a new one.' };
  }
  rec.attempts++;
  if (rec.attempts > MAX_ATTEMPTS) {
    otpStore.delete(target);
    return { ok: false, error: 'Too many incorrect attempts. Please request a new code.' };
  }

  const expected = Buffer.from(rec.hash);
  const actual = Buffer.from(hashCode(String(code || '').trim(), target));
  const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!match) return { ok: false, error: 'Incorrect code. Please try again.' };

  otpStore.delete(target);   // single use
  return { ok: true, verified: true };
}

module.exports = { requestOtp, verifyOtp };
