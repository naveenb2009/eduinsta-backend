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

Watch this video and decide whether it belongs on an educational platform.

APPROVE only if the video's PRIMARY PURPOSE is to teach, explain, demonstrate
or inform about a genuine educational subject. Examples that qualify:
- explaining a concept in science, maths, engineering, medicine
- history, geography, economics, civics, law
- language learning, literature analysis
- exam preparation, problem solving, study techniques
- practical skills instruction, lab demonstrations, how things work

REJECT if it is primarily:
- entertainment, comedy, memes, pranks, dance, music videos
- vlogs, lifestyle, travel diaries with no instructional content
- product promotion, advertising, get-rich-quick or crypto hype
- religious or political persuasion rather than factual education
- unrelated personal content
- gameplay with no instructional framing

ALSO REJECT (regardless of educational framing) if it contains:
- sexual or suggestive content
- graphic violence, gore, or self-harm
- instructions for weapons, explosives, drugs, or illegal activity
- hate speech, harassment, or content demeaning a group
- dangerous activities a viewer might imitate
- content that appears to sexualise or endanger minors
- demonstrably false claims presented as fact (e.g. medical misinformation)

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "approved": true or false,
  "category": one of ${JSON.stringify(ALLOWED_CATEGORIES)} or "not_educational",
  "subject": "short specific topic, e.g. 'Ohm's Law'",
  "confidence": 0.0 to 1.0,
  "reason": "one clear sentence the uploader will read",
  "safety_flags": ["array of any serious concerns, empty if none"],
  "suggested_title": "a concise accurate title, or null"
}`;
}

/* Upload the file to Gemini's Files API, then ask the model about it.
   Files API is used rather than inline base64 because reels routinely exceed
   the inline request size limit. */
async function analyseVideo(buffer, mimeType) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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
  if (!genRes.ok) throw new Error(`Gemini analysis failed: ${genRes.status}`);
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

/* Decide the final outcome. Deliberately conservative:
   - any safety flag is an automatic reject, whatever the model said
   - low confidence goes to a human queue instead of auto-approving
   Failing "open" (approving on error) would let anything through simply by
   breaking the API, so errors route to manual review instead. */
const MIN_CONFIDENCE = Number(process.env.MODERATION_MIN_CONFIDENCE || 0.7);

async function moderateVideo(buffer, mimeType) {
  let verdict;
  try {
    verdict = await analyseVideo(buffer, mimeType);
  } catch (err) {
    console.error('Moderation error:', err.message);
    return {
      status: 'manual_review',
      approved: false,
      reason: 'Automatic review is unavailable right now. Your reel has been queued for manual review.',
      error: err.message,
    };
  }

  const flags = Array.isArray(verdict.safety_flags) ? verdict.safety_flags : [];
  if (flags.length) {
    return {
      status: 'rejected',
      approved: false,
      category: verdict.category,
      reason: verdict.reason || 'This video does not meet our content safety guidelines.',
      safety_flags: flags,
    };
  }

  if (!verdict.approved) {
    return {
      status: 'rejected',
      approved: false,
      category: verdict.category || 'not_educational',
      reason: verdict.reason || 'This video does not appear to be educational content.',
    };
  }

  const confidence = Number(verdict.confidence ?? 0);
  if (confidence < MIN_CONFIDENCE) {
    return {
      status: 'manual_review',
      approved: false,
      category: verdict.category,
      confidence,
      reason: `We need a closer look at this one (confidence ${Math.round(confidence * 100)}%). It has been queued for manual review.`,
    };
  }

  return {
    status: 'approved',
    approved: true,
    category: verdict.category,
    subject: verdict.subject,
    confidence,
    suggested_title: verdict.suggested_title || null,
    reason: verdict.reason || 'Educational content confirmed.',
  };
}

module.exports = { moderateVideo, ALLOWED_CATEGORIES };
