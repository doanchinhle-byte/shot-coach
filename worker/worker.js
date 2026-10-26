/**
 * Shot Coach — AI Pro Photographer middleman (Cloudflare Worker)
 *
 * Holds the Anthropic API key so it never appears in the public web page.
 * Settings (Cloudflare → Worker → Settings → Variables and Secrets):
 *   ANTHROPIC_API_KEY  (Secret)  your Claude API key
 *   PASSCODE           (Secret)  code you and your staff type into the app once
 *   MODEL              (Text, optional) default "claude-haiku-5-5"
 *
 * Safety: only accepts requests from the Shot Coach page, requires the passcode,
 * limits image size, and rate-limits each device. Your monthly $ cap is set in
 * the Claude Console (Billing → Spend limits), which stops all spending at the cap.
 */
const ALLOWED_ORIGIN = "https://doanchinhle-byte.github.io";
const MAX_IMAGE_BYTES = 600_000;          // base64 JPEG from the app is ~80–150 KB
const PER_MINUTE = 12;                    // per device/IP
const hits = new Map();                   // best-effort, per worker instance

const cors = origin => ({
  "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
});
const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors(origin) } });

function sameSecret(a, b) {               // constant-time compare
  const x = new TextEncoder().encode(a || ""), y = new TextEncoder().encode(b || "");
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

const MODES = {
  food: "food or drink for a café/restaurant menu or social media",
  product: "a product photo for selling or advertising",
  people: "a photo of a person or people",
  place: "a place, storefront or scenery",
};

function prompt(mode, template, lang) {
  return `You are an award-winning professional photographer directing a beginner who is holding an iPhone right now.
The image is their live camera view. They are shooting ${MODES[mode] || "a photo"}${template ? ` using the "${template}" framing` : ""}.
Give direction they can act on in the next 10 seconds: what to move, where to stand, how to tilt the phone, how the person should pose (chin, shoulders, hands, gaze), what to remove from the frame, where the light should come from, styling (garnish, napkin, props).
Be specific to what you actually see. No camera settings or jargon. Short imperative sentences.
${lang === "vi" ? "Write all text in Vietnamese." : "Write all text in English."}
Reply with ONLY JSON:
{"score": 1-10 integer for the shot as it is now,
 "headline": "under 8 words: the single most important change, or praise if it's ready",
 "steps": ["2-4 directions, each under 14 words, most important first"],
 "pose": "one pose instruction for the person, or empty string if no person",
 "ready": true if they should take the photo now}`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return json({ error: "Use POST" }, 405, origin);
    if (origin !== ALLOWED_ORIGIN) return json({ error: "Not allowed" }, 403, origin);

    // rate limit per IP
    const ip = request.headers.get("CF-Connecting-IP") || "x";
    const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 60_000);
    if (list.length >= PER_MINUTE) return json({ error: "Too many requests. Wait a minute." }, 429, origin);
    list.push(now); hits.set(ip, list);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400, origin); }
    if (!sameSecret(body.passcode, env.PASSCODE)) return json({ error: "Wrong passcode" }, 401, origin);
    const img = String(body.image || "");
    if (!img || img.length > MAX_IMAGE_BYTES || !/^[A-Za-z0-9+/=]+$/.test(img)) return json({ error: "Image missing or too large" }, 400, origin);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: env.MODEL || "claude-haiku-5-5",
        max_tokens: 500,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: img } },
          { type: "text", text: prompt(String(body.mode || ""), String(body.template || "").slice(0, 40), body.lang) },
        ]}],
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error?.message || "";
      const capped = /usage limits/i.test(msg);
      return json({ error: capped ? "Monthly AI budget reached. It resets on the 1st." : "AI is unavailable right now. Try again." }, capped ? 402 : 502, origin);
    }
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    let out; try { out = JSON.parse(m ? m[0] : text); } catch { out = { score: 5, headline: "Try again", steps: [text.slice(0, 200)], pose: "", ready: false }; }
    return json(out, 200, origin);
  },
};
