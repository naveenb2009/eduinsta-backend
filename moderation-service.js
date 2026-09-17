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

Be GENEROUS. Your job is to let educational content through, not to gatekeep.
If a video has ANY plausible learning, informational or skill-building value,
APPROVE it. Only reject content that is clearly and entirely unrelated to
learning.

APPROVE (this list is illustrative, not exhaustive):
- any academic subject: science, maths, engineering, medicine, history,
  geography, economics, civics, law, languages, literature
- technology, programming, tools, software, hardware
- exam preparation, study tips, problem solving, revision, career guidance
- practical skills, tutorials, demonstrations, experiments, "how things work"
- explainers, documentaries, news analysis, factual commentary
- crafts, cooking technique, fitness technique, music theory, art technique
- educational content aimed at children, including simple or playful formats
- informal or entertaining teaching styles — humour does not disqualify it
- videos that are partly personal or casual but still teach something
- content where you are unsure: DEFAULT TO APPROVING

REJECT only if the video has no educational or informational value at all,
for example: pure dance/lip-sync, random pets or scenery with no commentary,
pure product advertising, or content that is simply unrelated to learning.

SEPARATELY, set safety_flags (and only then) if the video contains:
- sexual content, or any sexualisation of minors
- graphic violence or gore
- self-harm or suicide content
- instructions for weapons, explosives, or drug manufacture
- hate speech targeting a protected group
These are the only hard limits. Everything else should pass.

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "approved": true or false,
  "category": one of ${JSON.stringify(ALLOWED_CATEGORIES)} or "not_educational",
  "subject": "short specific topic",
  "confidence": 0.0 to 1.0,
  "reason": "one clear sentence the uploader will read",
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
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-flash-lite-latest',
  'gemini-2.0-flash-001',
  'gemini-pro-latest',
];

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

  // 3. Ask the model
  const genRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
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
  if (!genRes.ok) {
    const body = await genRes.text().catch(() => '');
    if (genRes.status === 404) {
      // The chosen model vanished or isn't valid for this key — clear the cache
      // so the next attempt re-discovers, and report something actionable.
      cachedModel = null;
      throw new Error(`Gemini model "${model}" not available for this API key (404). ${body.slice(0, 200)}`);
    }
    throw new Error(`Gemini analysis failed: ${genRes.status} ${body.slice(0, 200)}`);
  }
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
const MIN_CONFIDENCE = Number(process.env.MODERATION_MIN_CONFIDENCE || 0.25);

/* Only these flags block an upload. Anything else the model reports is noted
   but does not stop publication. */
const HARD_BLOCK = [
  'sexual', 'minor', 'child', 'csam', 'nudity', 'porn',
  'self-harm', 'selfharm', 'suicide',
  'weapon', 'explosive', 'bomb', 'firearm', 'drug manufacture',
  'gore', 'graphic violence', 'hate speech',
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
    confidence,
    reason: verdict.reason || 'This video does not appear to be educational content.',
  };
}

module.exports = { moderateVideo, ALLOWED_CATEGORIES };
