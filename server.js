/**
 * EduInsta backend — payments, subscription verification, owner earnings.
 *
 * WHY THIS EXISTS
 * ---------------
 * A static HTML app can NEVER safely take real money. Two reasons:
 *   1. Your Razorpay key_secret must never ship to a user's device.
 *   2. Payment success must be verified by signature on a trusted server —
 *      otherwise anyone can edit localStorage and grant themselves Premium.
 *
 * This server is the trusted half. It talks to TWO payment systems, split by
 * purchase type (Play Store policy requires this split, not just a choice):
 *   - Premium subscription (a consumer digital good, bought inside the app)
 *     -> Google Play Billing via RevenueCat. This server never sees card/UPI
 *     details for it; RevenueCat verifies the purchase against Google and
 *     calls /api/revenuecat-webhook here once confirmed.
 *   - Advertiser ad-campaign payments (a B2B service, not a digital good)
 *     -> still Razorpay, via /api/create-order + /api/verify-payment.
 *
 * SETUP
 * -----
 *   npm install
 *   cp .env.example .env     # then fill in your real values
 *   npm start
 *
 * Deploy anywhere that runs Node (Render, Railway, Fly.io, AWS, a VPS).
 * You must serve it over HTTPS in production.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const Razorpay = require('razorpay');
const { requestOtp, verifyOtp } = require('./otp-service');
const { moderateVideo } = require('./moderation-service');
const reelsService = require('./reels-service');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

const {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  REVENUECAT_WEBHOOK_AUTH,
  OWNER_TOKEN,
  PORT = 3000,
} = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.error('Missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET. See .env.example');
  process.exit(1);
}

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

/* ------------------------------------------------------------------
   STORAGE
   This demo keeps everything in memory so it runs with zero setup.
   REPLACE THIS with a real database (Postgres/Mongo) before going live —
   an in-memory store loses every subscription on restart.
   ------------------------------------------------------------------ */
const db = {
  subscriptions: new Map(), // userId -> { status, expiresAt, paymentId, amount }
  payments: [],             // append-only ledger of verified payments
  campaigns: [],            // advertiser bookings
};

/* Pricing lives server-side so a user can't tamper with the amount they pay. */
const PRICING = {
  premiumMonthly: Number(process.env.PREMIUM_PRICE_PAISE || 14900), // ₹149.00
  adPerDayPaise: Number(process.env.AD_PRICE_PER_DAY_PAISE || 4900), // ₹49.00
  billingCycleDays: 30,
};


/* ------------------------------------------------------------------
   0. OTP — real email / SMS delivery
   The code is generated, hashed and verified here. It is never sent
   back to the browser, so it can't be read out of the page.
   ------------------------------------------------------------------ */
app.post('/api/send-otp', async (req, res) => {
  const { target, channel } = req.body || {};
  if (!target) return res.status(400).json({ ok: false, error: 'target required' });

  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target);
  const isPhone = /^\+?[0-9]{7,15}$/.test(target);
  if (!isEmail && !isPhone) return res.status(400).json({ ok: false, error: 'Enter a valid email or phone number' });

  const result = await requestOtp(target, channel || (isPhone ? 'sms' : 'email'));
  res.status(result.ok ? 200 : 429).json(result);
});

app.post('/api/verify-otp', (req, res) => {
  const { target, code } = req.body || {};
  if (!target || !code) return res.status(400).json({ ok: false, error: 'target and code required' });
  const result = verifyOtp(target, code);
  res.status(result.ok ? 200 : 400).json(result);
});


/* ------------------------------------------------------------------
   EDUCATION CHECK — real AI moderation of uploaded reels.
   The client sends the video; Gemini watches it; we return a verdict.
   The client cannot skip this, because publishing is gated on the
   verdict being issued here.
   ------------------------------------------------------------------ */
app.post('/api/education-check', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ status: 'error', reason: 'No video supplied' });
  const result = await moderateVideo(req.file.buffer, req.file.mimetype);
  if (result.status === 'manual_review' || result.status === 'rejected') {
    db.moderationQueue = db.moderationQueue || [];
    db.moderationQueue.push({
      at: Date.now(),
      userId: req.body.userId || 'unknown',
      title: req.body.title || '',
      status: result.status,
      reason: result.reason,
    });
  }
  res.json(result);
});


/* ==================================================================
   SHARED REELS — the endpoints that make uploads visible to everyone
   ================================================================== */

/* Publish: moderate first, then store. A rejected video is never saved,
   so unsafe content never reaches storage at all. */
app.post('/api/reels', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video supplied' });
    const { title, description, category, subject, creator } = req.body;
    if (!title || !creator) return res.status(400).json({ error: 'title and creator are required' });

    const verdict = await moderateVideo(req.file.buffer, req.file.mimetype);
    if (!verdict.approved) {
      return res.status(422).json({ error: 'rejected', verdict });
    }

    const { key, url } = await reelsService.storeVideo(req.file.buffer, req.file.mimetype);
    const row = await reelsService.createReel({
      creator, title,
      description: description || '',
      category: category || verdict.category || '',
      subject: subject || verdict.subject || '',
      videoKey: key, videoUrl: url,
    });
    res.json({ ok: true, reel: reelsService.toClientReel(row), verdict });
  } catch (err) {
    console.error('publish failed:', err);
    res.status(500).json({ error: 'Could not publish the reel' });
  }
});

/* The shared feed. Keyset pagination — stays fast however deep you scroll. */
app.get('/api/feed', async (req, res) => {
  try {
    const { items, nextCursor } = await reelsService.listReels({
      limit: req.query.limit,
      cursor: req.query.cursor || null,
      creator: req.query.creator || null,
    });
    res.json({ reels: items.map(reelsService.toClientReel), nextCursor });
  } catch (err) {
    console.error('feed failed:', err);
    res.status(500).json({ error: 'Could not load the feed' });
  }
});

app.post('/api/reels/:id/like', async (req, res) => {
  try {
    const userId = req.body?.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json(await reelsService.toggleLike(req.params.id, userId));
  } catch {
    res.status(500).json({ error: 'Could not update the like' });
  }
});

app.post('/api/reels/:id/view', async (req, res) => {
  try { await reelsService.incrementViews(req.params.id); res.json({ ok: true }); }
  catch { res.json({ ok: false }); }
});

app.delete('/api/reels/:id', async (req, res) => {
  try {
    const ok = await reelsService.deleteReel(req.params.id, req.body?.creator);
    res.status(ok ? 200 : 404).json({ ok });
  } catch {
    res.status(500).json({ error: 'Could not delete the reel' });
  }
});

/* Comments — shared server-side so everyone viewing a reel sees the same
   list, not just the person who posted them. Still unmoderated (no change
   from before — see the education-check moderation above, which only
   screens VIDEOS, never comment text). */
app.post('/api/reels/:id/comments', async (req, res) => {
  try {
    const { userId, username, text } = req.body || {};
    if (!userId || !text) return res.status(400).json({ ok: false, error: 'userId and text are required' });
    const row = await reelsService.addComment(req.params.id, userId, username, text);
    res.json({ ok: true, comment: reelsService.toClientComment(row) });
  } catch (err) {
    console.error('add comment failed:', err);
    res.status(500).json({ ok: false, error: 'Could not post the comment' });
  }
});

app.get('/api/reels/:id/comments', async (req, res) => {
  try {
    const rows = await reelsService.listComments(req.params.id, { limit: req.query.limit });
    res.json({ ok: true, comments: rows.map(reelsService.toClientComment) });
  } catch (err) {
    console.error('list comments failed:', err);
    res.status(500).json({ ok: false, comments: [] });
  }
});

/* ------------------------------------------------------------------
   PROFILE PHOTOS — shared server-side (R2 + profiles table) so a user's
   avatar is actually visible to OTHER users, not just stored locally on
   their own device.
   ------------------------------------------------------------------ */
app.post('/api/profile/avatar', upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No image supplied' });
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({ ok: false, error: 'File must be an image' });
    }
    const avatarUrl = await reelsService.setAvatar(userId, req.file.buffer, req.file.mimetype);
    res.json({ ok: true, avatarUrl });
  } catch (err) {
    console.error('avatar upload failed:', err);
    res.status(500).json({ ok: false, error: 'Could not upload photo' });
  }
});

app.delete('/api/profile/avatar/:userId', async (req, res) => {
  try {
    await reelsService.deleteAvatar(req.params.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('avatar delete failed:', err);
    res.status(500).json({ ok: false, error: 'Could not remove photo' });
  }
});

/* Batch lookup - the feed asks for every creator id on the page in one call
   rather than one request per reel. ?ids=a@x.com,b@y.com */
app.get('/api/avatars', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
    const avatars = await reelsService.getAvatars(ids);
    res.json({ ok: true, avatars });
  } catch (err) {
    console.error('avatar lookup failed:', err);
    res.status(500).json({ ok: false, avatars: {} });
  }
});

/* Fallback video streaming for when no public R2 domain is configured.
   Supports Range requests, which video players require for seeking. */
app.get('/api/video/:key', async (req, res) => {
  try {
    const { buffer, mime } = await reelsService.readVideo(decodeURIComponent(req.params.key));
    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10) || 0;
      const end = endStr ? parseInt(endStr, 10) : buffer.length - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${buffer.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime,
      });
      return res.end(buffer.slice(start, end + 1));
    }
    res.writeHead(200, { 'Content-Length': buffer.length, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    res.end(buffer);
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});

/* ------------------------------------------------------------------
   1. CREATE ORDER  — called when the user taps "Pay"
   The client never chooses the amount; the server does.
   ------------------------------------------------------------------ */
app.post('/api/create-order', async (req, res) => {
  try {
    const { type, userId, days } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // Premium is a consumer digital good and, per Play Store policy, must go
    // through Google Play Billing (see PurchasesService in the app + the
    // /api/revenuecat-webhook route below), not this Razorpay order flow.
    // This route now only creates orders for advertiser ad-campaign payments.
    if (type === 'premium') {
      return res.status(400).json({ error: 'Premium is purchased via Google Play Billing, not this endpoint' });
    }

    let amount, notes;
    if (type === 'ad_campaign') {
      const d = Math.max(1, Math.min(30, Number(days) || 1));
      amount = PRICING.adPerDayPaise * d;
      notes = { type: 'ad_campaign', userId, days: String(d) };
    } else {
      return res.status(400).json({ error: 'unknown order type' });
    }

    const order = await razorpay.orders.create({
      amount,                       // in paise
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`,
      notes,
    });

    // Only the PUBLIC key id goes to the client. Never the secret.
    res.json({ orderId: order.id, amount, currency: 'INR', keyId: RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('create-order failed', err);
    res.status(500).json({ error: 'could not create order' });
  }
});

/* ------------------------------------------------------------------
   2. VERIFY PAYMENT — the security-critical step.
   Razorpay returns a signature; we recompute it with our secret.
   If it doesn't match, the payment is fake and we grant nothing.
   ------------------------------------------------------------------ */
app.post('/api/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId, type, days } = req.body;

  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  // timingSafeEqual avoids leaking information through comparison timing
  const valid =
    expected.length === (razorpay_signature || '').length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpay_signature));

  if (!valid) {
    return res.status(400).json({ ok: false, error: 'Signature verification failed' });
  }

  const now = Date.now();
  // Premium no longer settles here -- see /api/revenuecat-webhook below.
  if (type === 'ad_campaign') {
    const d = Math.max(1, Math.min(30, Number(days) || 1));
    const amountPaise = PRICING.adPerDayPaise * d;
    const campaign = { id: razorpay_payment_id, userId, days: d, amountPaise, startAt: now, endAt: now + d * 86400000, status: 'active' };
    db.campaigns.push(campaign);
    db.payments.push({ at: now, userId, type: 'ad_campaign', amountPaise, paymentId: razorpay_payment_id });
    return res.json({ ok: true, campaign });
  }

  res.status(400).json({ ok: false, error: 'unknown type' });
});

/* ------------------------------------------------------------------
   3. SUBSCRIPTION STATUS — the app asks the server, not localStorage.
   This is what makes Premium un-fakeable from the client.
   ------------------------------------------------------------------ */
app.get('/api/subscription/:userId', (req, res) => {
  const sub = db.subscriptions.get(req.params.userId);
  if (!sub) return res.json({ status: 'free' });
  if (Date.now() > sub.expiresAt) {
    sub.status = 'expired';
    return res.json({ status: 'expired', expiresAt: sub.expiresAt });
  }
  res.json({ status: sub.status, expiresAt: sub.expiresAt });
});

/* ------------------------------------------------------------------
   3b. DELETE ACCOUNT — Google Play requires any app with account creation
   to offer in-app account + data deletion (not just a web form). Removes:
     - the user's subscription record
     - every reel/video they've uploaded (Postgres row + R2 file)
   Payment ledger rows are ANONYMIZED rather than deleted (userId blanked,
   amounts kept) — standard practice, since payment records often need to
   be retained for accounting/tax purposes even after a user deletes their
   account.

   Two ways in, both landing here:
     - DELETE /api/account/:userId — called from INSIDE the app (Settings >
       Delete account). No extra verification needed: the user is already
       authenticated on their own device (auth here is local to the
       device, see index.html), which the app then clears immediately.
     - POST /api/request-account-deletion — the public web page
       (/delete-account) required by Play Store policy for users who no
       longer have the app installed. Since there's no device session to
       trust here, this path requires a fresh OTP (the same
       send-otp/verify-otp flow used for sign-in) before deleting anything.
   ------------------------------------------------------------------ */
async function performAccountDeletion(userId) {
  db.subscriptions.delete(userId);
  db.payments.forEach((p) => {
    if (p.userId === userId) p.userId = '[deleted-user]';
  });
  try {
    await reelsService.deleteAvatar(userId);
  } catch (err) {
    console.error('account deletion: failed to delete avatar for', userId, err);
  }
  try {
    // Comments this user posted on OTHER people's reels. Comments on their
    // OWN reels are removed as a side effect of deleteAllReelsByCreator
    // below (deleting a reel cascades to its comments).
    await reelsService.deleteCommentsByUser(userId);
  } catch (err) {
    console.error('account deletion: failed to delete comments for', userId, err);
  }
  try {
    return await reelsService.deleteAllReelsByCreator(userId);
  } catch (err) {
    console.error('account deletion: failed to delete reels for', userId, err);
    // Continue rather than fail the whole request — subscription/payment
    // cleanup above already succeeded, and the user should not be blocked
    // from deleting their account by a storage hiccup.
    return 0;
  }
}

app.delete('/api/account/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
  const reelsDeleted = await performAccountDeletion(userId);
  console.log(`Account deleted (in-app): ${userId} (${reelsDeleted} reel(s) removed)`);
  res.json({ ok: true, reelsDeleted });
});

app.post('/api/request-account-deletion', async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ ok: false, error: 'email and code required' });
  const result = verifyOtp(email, code);
  if (!result.ok) return res.status(400).json(result);
  const reelsDeleted = await performAccountDeletion(email);
  console.log(`Account deleted (web request): ${email} (${reelsDeleted} reel(s) removed)`);
  res.json({ ok: true, reelsDeleted });
});

/* ------------------------------------------------------------------
   4. RAZORPAY WEBHOOK — authoritative source for renewals/refunds.
   Configure this URL in your Razorpay dashboard.
   NOTE: needs the RAW body to verify the signature, so it is mounted
   with express.raw rather than the JSON parser above.
   ------------------------------------------------------------------ */
app.post('/api/razorpay-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET || '')
    .update(req.body)
    .digest('hex');

  if (signature !== expected) return res.status(400).send('invalid signature');

  const event = JSON.parse(req.body.toString());
  console.log('webhook event:', event.event);
  // Handle subscription.charged / payment.failed / refund.created here,
  // updating db.subscriptions accordingly.
  res.json({ received: true });
});

/* ------------------------------------------------------------------
   4b. REVENUECAT WEBHOOK — authoritative source for Premium.
   Configure this URL (Project settings > Integrations > Webhooks) in the
   RevenueCat dashboard, with the same secret string as REVENUECAT_WEBHOOK_AUTH
   below set as the "Authorization header value". RevenueCat has already
   verified the purchase against Google Play on its own infrastructure by the
   time this fires -- our job here is just to trust RevenueCat (via the
   shared secret) and mirror its verdict into db.subscriptions, the same
   table /api/subscription/:userId reads from.
   Event types: https://www.revenuecat.com/docs/integrations/webhooks/event-types
   ------------------------------------------------------------------ */
app.post('/api/revenuecat-webhook', express.json(), (req, res) => {
  if (!REVENUECAT_WEBHOOK_AUTH) {
    console.error('REVENUECAT_WEBHOOK_AUTH not set — rejecting webhook. See .env.example');
    return res.status(500).json({ error: 'webhook not configured' });
  }
  const auth = req.headers['authorization'];
  if (auth !== REVENUECAT_WEBHOOK_AUTH) {
    return res.status(401).json({ error: 'invalid authorization' });
  }

  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: 'missing event' });

  // app_user_id is whatever we passed as appUserID when calling
  // Purchases.configure() client-side — currentUserId() in index.html.
  const userId = event.app_user_id;
  const now = Date.now();

  const ACTIVE_TYPES = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE']);
  const INACTIVE_TYPES = new Set(['EXPIRATION', 'CANCELLATION']);

  if (userId && ACTIVE_TYPES.has(event.type)) {
    const expiresAt = event.expiration_at_ms ? Number(event.expiration_at_ms) : now + PRICING.billingCycleDays * 86400000;
    db.subscriptions.set(userId, {
      status: 'active',
      expiresAt,
      paymentId: event.transaction_id || event.id,
      amount: PRICING.premiumMonthly,
    });
    db.payments.push({ at: now, userId, type: 'premium', amountPaise: PRICING.premiumMonthly, paymentId: event.transaction_id || event.id });
  } else if (userId && INACTIVE_TYPES.has(event.type)) {
    const existing = db.subscriptions.get(userId);
    if (existing) existing.status = 'expired';
  }

  res.json({ received: true });
});

/* ------------------------------------------------------------------
   5. OWNER EARNINGS — private. Requires the owner token.
   This is the REAL protection for your revenue data; the PIN in the
   mobile app only hides the UI, it does not protect anything by itself.
   ------------------------------------------------------------------ */
function requireOwner(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!OWNER_TOKEN || token !== OWNER_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

app.get('/api/owner/earnings', requireOwner, (req, res) => {
  const GATEWAY_FEE_RATE = 0.0236; // ~2% + 18% GST
  const subPayments = db.payments.filter((p) => p.type === 'premium');
  const adPayments = db.payments.filter((p) => p.type === 'ad_campaign');
  const sum = (arr) => arr.reduce((s, p) => s + p.amountPaise, 0);

  const subGross = sum(subPayments);
  const adGross = sum(adPayments);
  const gross = subGross + adGross;
  const fees = Math.round(gross * GATEWAY_FEE_RATE);

  res.json({
    currency: 'INR',
    // amounts returned in paise; divide by 100 for rupees
    subGrossPaise: subGross,
    adGrossPaise: adGross,
    grossPaise: gross,
    estFeesPaise: fees,
    netPaise: gross - fees,
    subscriptionCount: subPayments.length,
    campaignCount: adPayments.length,
    transactions: db.payments.slice(-100).reverse(),
  });
});


/* Diagnostic: shows which Gemini models this API key can actually use.
   Open in a browser to debug 404s from the moderation service. */
app.get('/api/debug/gemini-models', async (_req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.json({ ok: false, error: 'GEMINI_API_KEY not set' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    if (!r.ok) return res.json({ ok: false, status: r.status, error: await r.text() });
    const d = await r.json();
    res.json({
      ok: true,
      usableForGenerateContent: (d.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace('models/', '')),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* ------------------------------------------------------------------
   SHAREABLE REEL LANDING PAGE — makes "Share" behave like Instagram/TikTok.

   Sharing used to hand out the raw video file URL, which WhatsApp/Telegram
   show as a bare "website link" and which just plays the file in a browser
   — never opening the app. This page is what gets shared instead:

     1. A messaging app's link-preview crawler (WhatsApp, Telegram, iMessage)
        fetches this URL and reads the Open Graph tags below to build a rich
        preview card (thumbnail + title), not a plain blue link.
     2. On Android, if EduInsta is installed, Android's App Links system
        intercepts this https:// URL BEFORE it reaches a browser (see the
        intent-filter injected into AndroidManifest.xml + the
        /.well-known/assetlinks.json route below) and opens the app
        straight to this exact reel. This HTML is only ever actually
        rendered as a fallback — someone without the app installed, or on
        a platform without App Links support.
   ------------------------------------------------------------------ */
function escapeHtmlText(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
app.get('/reel/:id', async (req, res) => {
  try {
    const row = await reelsService.getReel(req.params.id);
    if (!row) return res.status(404).send('This reel is no longer available.');
    const r = reelsService.toClientReel(row);
    const title = escapeHtmlText(`${r.title} — EduInsta`);
    const desc = escapeHtmlText(r.desc || `${r.creator} on EduInsta`);
    const origin = `${req.protocol}://${req.get('host')}`;
    // og:video / <video src> must be an ABSOLUTE url — WhatsApp/Telegram's
    // preview crawlers (and most players) won't resolve a relative one the
    // way the app's own resolveMediaUrl() does client-side.
    const rawSrc = r.src && /^https?:/i.test(r.src) ? r.src : (r.src ? `${origin}${r.src.startsWith('/') ? '' : '/'}${r.src}` : '');
    const videoUrl = rawSrc ? escapeHtmlText(rawSrc) : '';
    const pageUrl = escapeHtmlText(`${origin}/reel/${r.id}`);
    const appLink = `eduinsta://reel/${encodeURIComponent(r.id)}`;
    res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="video.other">
<meta property="og:url" content="${pageUrl}">
${videoUrl ? `<meta property="og:video" content="${videoUrl}">\n<meta property="og:video:type" content="video/mp4">\n<meta name="twitter:card" content="player">` : ''}
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#05070c;color:#fff;text-align:center;padding:40px 20px;margin:0}
video{max-width:360px;width:100%;border-radius:16px;margin-top:20px}
a.btn{display:inline-block;margin-top:20px;padding:12px 24px;border-radius:24px;background:linear-gradient(135deg,#5eead4,#38bdf8);color:#05070c;text-decoration:none;font-weight:600}
p.muted{color:#9aa4b8}</style>
</head><body>
<h2>${title}</h2>
<p class="muted">${desc}</p>
<a class="btn" href="${appLink}">Open in EduInsta</a>
<p class="muted" style="margin-top:14px">Don't have the app? <a href="https://play.google.com/store/apps/details?id=com.eduinsta.app" style="color:#5eead4">Get it on Google Play</a></p>
${videoUrl ? `<video src="${videoUrl}" controls playsinline></video>` : ''}
<script>
  // If EduInsta is installed but Android's App Link verification hasn't
  // kicked in yet on this device, the button above still opens the app via
  // its custom URL scheme. Never auto-redirect - some browsers show a scary
  // warning dialog for that, so this stays a deliberate tap.
</script>
</body></html>`);
  } catch (err) {
    console.error('reel landing page failed:', err);
    res.status(500).send('Something went wrong loading this reel.');
  }
});

/* Android App Links verification file. Confirms to Android that WE, the
   owner of this domain, authorize com.eduinsta.app to auto-open
   https://<this host>/reel/* links directly instead of a browser.
   Must be served at exactly this path as JSON (res.json sets that). */
const APP_LINK_CERT_FINGERPRINTS = [
  '9A:45:51:3A:45:A5:56:F1:02:6B:E0:1B:34:1A:C6:3A:2F:06:8A:40:B4:1D:49:50:CE:F8:0E:71:4C:AF:D3:42',
];
app.get('/.well-known/assetlinks.json', (_req, res) => {
  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.eduinsta.app',
        sha256_cert_fingerprints: APP_LINK_CERT_FINGERPRINTS,
      },
    },
  ]);
});

/* ------------------------------------------------------------------
   PRIVACY POLICY — required by Play Console (App content > Privacy
   policy) and by RevenueCat/AdMob account setup. Read from disk once at
   startup and cached in memory; edit privacy-policy.html and redeploy to
   update it, no code change needed here.
   ------------------------------------------------------------------ */
const PRIVACY_POLICY_HTML = fs.readFileSync(path.join(__dirname, 'privacy-policy.html'), 'utf8');
app.get('/privacy', (_req, res) => res.type('html').send(PRIVACY_POLICY_HTML));

/* ------------------------------------------------------------------
   ACCOUNT DELETION PAGE — required by Play Console (App content >
   Data safety / Account deletion) as a public, no-login-required way
   to request account deletion. Same read-from-disk pattern as
   /privacy above; the page itself calls /api/send-otp, /api/verify-otp
   is skipped in favour of a single combined step at
   /api/request-account-deletion (which does its own OTP check).
   ------------------------------------------------------------------ */
const DELETE_ACCOUNT_HTML = fs.readFileSync(path.join(__dirname, 'delete-account.html'), 'utf8');
app.get('/delete-account', (_req, res) => res.type('html').send(DELETE_ACCOUNT_HTML));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

reelsService.initSchema()
  .then(() => app.listen(PORT, () => console.log(`EduInsta backend listening on :${PORT}`)))
  .catch((err) => { console.error('Schema init failed:', err); process.exit(1); });
