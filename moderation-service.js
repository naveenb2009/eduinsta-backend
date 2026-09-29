/**
 * Education Check — real AI content moderation.
 *
 * Sends the uploaded video to Gemini, which watches it and decides whether
 * it is genuinely educational, and whether it contains anything unsafe.
 *
 * WHY THIS IS ON THE SERVER
 * -------------------------
 * Same reason as payments and OTP: the API key must never ship in the app.
 * Beyond that, a check that runs in the user's browser is one they can simply
 * skip with devtools. Moderation that the uploader controls isn't moderation.
 *
 * COST (verify current rates — they change)
 * ----------------------------------------
 * Video input is billed per token and scales with duration. A short reel
 * (30-60s) analysed with a Flash-tier model typically lands in the fraction-
 * of-a-cent range. Budget a few hundred rupees per thousand uploads and
 * measure against your real traffic before relying on that number.
 */

const ALLOWED_CATEGORIES = [
  'science', 'technology', 'engineering', 'mathematics', 'medicine',
  'history', 'geography', 'language', 'literature', 'economics',
  'business', 'arts_education', 'exam_preparation', 'skills_training',
  'general_education',
];

/* The prompt is the whole product here. It is deliberately strict about what
   counts as educational, and asks for structured JSON so the result can be
   acted on programmatically rather than parsed out of prose. */
function buildPrompt() {
  return `You are the content reviewer for EduInsta, an educational short-video platform.

Decide whether this video belongs on an EDUCATION app. Be fair, not harsh:
approve anything where a meaningful part of the video teaches, explains,
informs or builds a skill. Reject only when the WHOLE video is clearly
unrelated to learning, education or technology.

APPROVE (illustrative, not exhaustive):
- any academic or school/college subject: science, maths, engineering, medicine,
  history, geography, economics, civics, law, languages, literature, commerce
- technology, programming, software, hardware, electronics, AI
- exam preparation (school boards, JEE, NEET, UPSC, SSC, banking, GATE, CAT...),
  study tips, revision, career guidance, interview preparation
- practical skills, tutorials, demonstrations, experiments, "how things work",
  cooking/fitness/music/art technique taught step by step
- explainers, documentaries, factual news analysis, general knowledge
- educational content for children, including playful formats
- a teaching video with humour or an informal style is still educational
- a teacher, coach or institute sharing lessons, tips or exam advice
- if it is genuinely borderline, lean towards APPROVING

REJECT when the whole video is one of these, with no real teaching in it:
- comedy skits, pranks, memes, roasts, challenges and trends
- dance, lip-sync, singing or music videos with no lesson
- movie/TV/web-series clips, celebrity gossip, fashion or beauty with no how-to
- gaming or vlogs with no teaching, random pets/scenery/daily-life footage
- pure advertisements or product/brand promotion (advertisers use the separate
  "Advertise on EduInsta" flow, so set content_type to "advertisement")
- sexual, suggestive or adult content of any kind (set safety_flags)

SEPARATELY, set safety_flags (and only then) if the video contains:
- sexual, nude, suggestive or adult content, or any sexualisation of minors
- graphic violence or gore
- self-harm or suicide content
- instructions for weapons, explosives, or drug manufacture
- hate speech targeting a protected group

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "approved": true or false,
  "content_type": "educational" | "entertainment" | "advertisement" | "adult" | "other",
  "category": one of ${JSON.stringify(ALLOWED_CATEGORIES)} or "not_educational",
  "subject": "short specific topic",
  "confidence": 0.0 to 1.0 (how sure you are of the approved/rejected decision),
  "reason": "one clear, polite sentence the uploader will read, saying what the video is and why it does not fit (or fits)",
  "safety_flags": ["only for the serious categories above; empty otherwise"],
  "suggested_title": "a concise accurate title, or null"
}`;
}

/* Upload the file to Gemini's Files API, then ask the model about it.
   Files API is used rather than inline base64 because reels routinely exceed
   the inline request size limit. */
/* Model IDs available on the Gemini API vary by account, region and over time,
   so hardcoding one produces intermittent 404s. Instead we ask the API which
   models this key can actually use, and pick the best available that supports
   generateContent. Result is cached for the process lifetime. */
let cachedModel = null;
const MODEL_PREFERENCE = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-pro-latest',
];
/* Tried in this order when the chosen model is overloaded (503/429) or missing
   (404). Names that don't exist for a given key simply 404 and are skipped. */
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-flash-lite-latest'];
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickModel(key) {
  if (cachedModel) return cachedModel;
  if (process.env.GEMINI_MODEL) {
    cachedModel = process.env.GEMINI_MODEL;   // explicit override wins
    return cachedModel;
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
  if (!res.ok) throw new Error(`Could not list Gemini models: ${res.status}`);
  const data = await res.json();
  const usable = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name).replace(/^models\//, ''));

  if (!usable.length) throw new Error('No Gemini models available for this API key');

  cachedModel =
    MODEL_PREFERENCE.find((p) => usable.includes(p)) ||
    usable.find((m) => m.includes('flash')) ||
    usable[0];

  console.log(`Moderation using Gemini model: ${cachedModel}`);
  return cachedModel;
}

async function analyseVideo(buffer, mimeType) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');
  const model = await pickModel(key);

  // 1. Upload
  const uploadRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${key}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'raw',
        'Content-Type': mimeType || 'video/mp4',
      },
      body: buffer,
    }
  );
  if (!uploadRes.ok) throw new Error(`Gemini upload failed: ${uploadRes.status}`);
  const uploaded = await uploadRes.json();
  const fileUri = uploaded?.file?.uri;
  const fileName = uploaded?.file?.name;
  if (!fileUri) throw new Error('Gemini did not return a file URI');

  // 2. Wait for processing — video files are not queryable immediately
  let state = uploaded.file.state;
  for (let i = 0; i < 30 && state === 'PROCESSING'; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${key}`
    );
    const j = await st.json();
    state = j?.state;
  }
  if (state !== 'ACTIVE') throw new Error(`Gemini file not ready (state: ${state})`);

  // 3. Ask the model. Google's models return 503 "high demand" in bursts, so
  //    retry with a short backoff, then fall back to the next model.
  const candidates = [model, ...FALLBACK_MODELS.filter((m) => m !== model)];
  let genRes = null;
  let lastErr = '';
  outer:
  for (const m of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(1500 * attempt);
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: buildPrompt() },
                { file_data: { mime_type: mimeType || 'video/mp4', file_uri: fileUri } },
              ],
            }],
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
          }),
        }
      );
      if (r.ok) {
        genRes = r;
        if (m !== model) console.log(`Moderation fell back to model ${m}`);
        break outer;
      }
      const body = await r.text().catch(() => '');
      lastErr = `Gemini analysis failed (${m}): ${r.status} ${body.slice(0, 200)}`;
      if (r.status === 404) break;            // model not available -> next model
      if (!RETRYABLE.has(r.status)) throw new Error(lastErr);
    }
  }
  if (!genRes) throw new Error(lastErr || 'Gemini analysis failed');
  const data = await genRes.json();

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  let verdict;
  try {
    verdict = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    throw new Error('Could not parse the moderation verdict');
  }

  // 4. Clean up the uploaded file — don't leave user video sitting on Google's servers
  fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${key}`, {
    method: 'DELETE',
  }).catch(() => {});

  return verdict;
}

/* Final outcome. Deliberately permissive:
   - there is NO manual-review state; every upload resolves to approved or rejected
   - the confidence bar is low, so borderline educational content passes
   - if the moderation API itself fails, we APPROVE rather than block the user,
     and record it so the owner can look back through the dashboard

   The one thing that is NOT permissive: safety_flags. Sexual content involving
   minors, self-harm instructions and weapon/drug manufacture are hard rejects
   regardless of how educational the framing is. That isn't strictness, it's the
   baseline every platform needs to stay operable and lawful. */
const MIN_CONFIDENCE = Number(process.env.MODERATION_MIN_CONFIDENCE || 0.5);

/* Only these flags block an upload. Anything else the model reports is noted
   but does not stop publication. */
const HARD_BLOCK = [
  'sexual', 'minor', 'child', 'csam', 'nudity', 'porn',
  'self-harm', 'selfharm', 'suicide',
  'weapon', 'explosive', 'bomb', 'firearm', 'drug manufacture',
  'gore', 'graphic violence', 'hate speech',
  'suggestive', 'adult', 'explicit',
];

function isHardBlock(flags) {
  return flags.some((f) => {
    const t = String(f).toLowerCase();
    return HARD_BLOCK.some((h) => t.includes(h));
  });
}

async function moderateVideo(buffer, mimeType) {
  let verdict;
  try {
    verdict = await analyseVideo(buffer, mimeType);
  } catch (err) {
    // Fail OPEN: an outage on our side must not block a creator's upload.
    console.error('Moderation unavailable, approving by default:', err.message);
    return {
      status: 'approved',
      approved: true,
      category: 'general_education',
      confidence: null,
      unreviewed: true,          // surfaced in the owner dashboard
      reason: 'Published. Automatic review was unavailable, so this was approved by default.',
      error: err.message,
    };
  }

  const flags = Array.isArray(verdict.safety_flags) ? verdict.safety_flags : [];
  if (flags.length && isHardBlock(flags)) {
    return {
      status: 'rejected',
      approved: false,
      category: verdict.category,
      content_type: verdict.content_type || 'adult',
      reason: verdict.reason || 'This video does not meet our content safety guidelines.',
      safety_flags: flags,
    };
  }

  const confidence = Number(verdict.confidence ?? 1);

  // Approve if the model said yes, OR if it said no but wasn't confident about it.
  if (verdict.approved || confidence < MIN_CONFIDENCE) {
    return {
      status: 'approved',
      approved: true,
      category: verdict.category === 'not_educational' ? 'general_education' : verdict.category,
      subject: verdict.subject,
      confidence,
      suggested_title: verdict.suggested_title || null,
      reason: verdict.reason || 'Educational content confirmed.',
    };
  }

  return {
    status: 'rejected',
    approved: false,
    category: verdict.category || 'not_educational',
    content_type: verdict.content_type || 'other',
    confidence,
    reason: verdict.reason || 'This video does not appear to be educational content.',
  };
}

module.exports = { moderateVideo, ALLOWED_CATEGORIES };
