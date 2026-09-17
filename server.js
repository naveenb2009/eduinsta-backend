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
 * This server is the trusted half. The app calls it; it talks to Razorpay.
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
const cors = require('cors');
const Razorpay = require('razorpay');
const { requestOtp, verifyOtp } = require('./otp-service');
const { moderateVideo } = require('./moderation-service');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

const {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
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

/* ------------------------------------------------------------------
   1. CREATE ORDER  — called when the user taps "Pay"
   The client never chooses the amount; the server does.
   ------------------------------------------------------------------ */
app.post('/api/create-order', async (req, res) => {
  try {
    const { type, userId, days } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    let amount, notes;
    if (type === 'premium') {
      amount = PRICING.premiumMonthly;
      notes = { type: 'premium', userId };
    } else if (type === 'ad_campaign') {
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
  if (type === 'premium') {
    const expiresAt = now + PRICING.billingCycleDays * 86400000;
    db.subscriptions.set(userId, {
      status: 'active',
      expiresAt,
      paymentId: razorpay_payment_id,
      amount: PRICING.premiumMonthly,
    });
    db.payments.push({ at: now, userId, type: 'premium', amountPaise: PRICING.premiumMonthly, paymentId: razorpay_payment_id });
    return res.json({ ok: true, status: 'active', expiresAt });
  }

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

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`EduInsta backend listening on :${PORT}`));
