// Google Gemini via the Generative Language REST API (no SDK needed).
// Free-tier quotas are per model, so JARVIS keeps a chain of Flash models and
// moves down it when one is rate-limited or overloaded.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const COOLDOWN_MS = 10 * 60 * 1000;

let candidates = null; // ordered model names
const benchedUntil = new Map(); // model -> timestamp it may be retried
let lastUsed = null;

export const geminiConfigured = () => Boolean(process.env.GEMINI_API_KEY);
export const geminiModel = () => process.env.GEMINI_MODEL || lastUsed || 'auto';

async function request(path, init = {}) {
  const res = await fetch(`${BASE}/${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error?.message || `Gemini HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Newest stable Flash models first, then Flash-Lite, then the "-latest" aliases.
async function modelChain() {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  if (candidates) return candidates;
  const { models = [] } = await request('models?pageSize=200');
  const names = models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
  const version = (n) => parseFloat(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || 0);
  const byVersion = (re) => names.filter((n) => re.test(n)).sort((a, b) => version(b) - version(a));
  candidates = [
    ...byVersion(/^gemini-\d+(\.\d+)?-flash$/),
    ...byVersion(/^gemini-\d+(\.\d+)?-flash-lite$/),
    ...names.filter((n) => /^gemini-flash(-lite)?-latest$/.test(n)),
  ];
  if (!candidates.length) candidates = byVersion(/^gemini-/).filter((n) => !/(image|tts|audio|live|embedding)/.test(n));
  if (!candidates.length) throw new Error('No Gemini text model is available for this API key.');
  console.log(`[gemini] model chain: ${candidates.slice(0, 6).join(' → ')}${candidates.length > 6 ? ' …' : ''}`);
  return candidates;
}

const isCapacityError = (err) =>
  [429, 500, 502, 503, 504].includes(err.status) || err.name === 'TimeoutError' || /quota|overloaded|high demand/i.test(err.message);

/**
 * Ask Gemini for JSON matching `schema`.
 * messages: [{ role: 'user' | 'assistant', content: string }]
 */
export async function geminiJSON({ system, messages, schema }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseJsonSchema: schema },
  };

  const chain = await modelChain();
  const now = Date.now();
  const ready = chain.filter((m) => (benchedUntil.get(m) || 0) <= now);
  const order = ready.length ? ready : chain; // everything benched: try anyway
  let lastErr;

  for (const model of order) {
    try {
      const json = await generate(model, body);
      lastUsed = model;
      return parse(json);
    } catch (err) {
      lastErr = err;
      if (!isCapacityError(err)) throw err;
      benchedUntil.set(model, Date.now() + COOLDOWN_MS);
      console.warn(`[gemini] ${model} unavailable (${err.message.slice(0, 80)}); trying next model`);
    }
  }
  throw lastErr;
}

async function generate(model, body) {
  try {
    return await request(`models/${model}:generateContent`, { method: 'POST', body: JSON.stringify(body) });
  } catch (err) {
    // Some models don't accept responseJsonSchema; the format is also described in the prompt, so retry without it.
    if (err.status !== 400 || !/schema/i.test(err.message)) throw err;
    const { responseJsonSchema, ...config } = body.generationConfig;
    return request(`models/${model}:generateContent`, { method: 'POST', body: JSON.stringify({ ...body, generationConfig: config }) });
  }
}

function parse(json) {
  const cand = json.candidates?.[0];
  if (!cand) throw Object.assign(new Error(`Gemini returned no answer (${json.promptFeedback?.blockReason || 'blocked'})`), { refusal: true });
  const text = (cand.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text) throw Object.assign(new Error(`Gemini stopped: ${cand.finishReason}`), { refusal: cand.finishReason === 'SAFETY' });
  return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
}
