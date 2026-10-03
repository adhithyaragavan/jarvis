// Turns Tony's natural-language request into an ordered list of steps.
// Uses Gemini or Claude when a key is configured, and a deterministic
// rule-based parser otherwise.
import Anthropic from '@anthropic-ai/sdk';
import { store } from './store.js';
import { ruleParse } from './ruleParser.js';
import { geminiJSON, geminiConfigured, geminiModel } from './gemini.js';

export const ACTIONS = [
  'create_event',
  'list_events',
  'cancel_event',
  'create_reminder',
  'list_reminders',
  'complete_reminder',
  'delete_reminder',
  'upload_file',
  'search_drive',
  'open_drive',
  'send_message',
  'list_messages',
];

const nullable = (type, description) => ({ anyOf: [{ type }, { type: 'null' }], description });

const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'action', 'title', 'start', 'end', 'description', 'location', 'text', 'due',
    'query', 'from', 'to', 'folder_name', 'create_folder', 'recipient', 'message',
  ],
  properties: {
    action: { type: 'string', enum: ACTIONS },
    title: nullable('string', 'create_event: event title'),
    start: nullable('string', 'create_event: ISO 8601 start with UTC offset'),
    end: nullable('string', 'create_event: ISO 8601 end with UTC offset (default +1h)'),
    description: nullable('string', 'create_event: description if Tony gave one'),
    location: nullable('string', 'create_event: location if given'),
    text: nullable('string', 'create_reminder: what to remind about'),
    due: nullable('string', 'create_reminder: ISO 8601 due time with UTC offset'),
    query: nullable('string', 'search_drive / cancel_event / complete_reminder / delete_reminder / list_events: search text'),
    from: nullable('string', 'list_events / list_reminders: ISO range start'),
    to: nullable('string', 'list_events / list_reminders: ISO range end'),
    folder_name: nullable('string', 'upload_file / open_drive: target Drive folder name, null = My Drive / let Tony choose'),
    create_folder: nullable('boolean', 'upload_file: true if Tony asked for a NEW folder'),
    recipient: nullable('string', 'send_message: contact name exactly as Tony said it, or "team"'),
    message: nullable('string', 'send_message: the final message text to send, written in first person as Tony'),
  },
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'needs_clarification', 'clarification_question', 'steps'],
  properties: {
    reply: { type: 'string', description: 'Short JARVIS-style acknowledgement, addressed to Tony as "sir"' },
    needs_clarification: { type: 'boolean' },
    clarification_question: nullable('string', 'Question to ask if required info is missing'),
    steps: { type: 'array', items: STEP_SCHEMA },
  },
};

const SYSTEM = `You are JARVIS, Tony Stark's personal AI. You convert Tony's requests into executable steps for his command centre.

Capabilities (one step each):
- create_event: Google Calendar event. Needs title + start. Default duration 1 hour. Turn "a meeting with Bruce" into a title like "Meeting with Bruce Banner".
- list_events: show calendar for a range ("what do I have tomorrow" -> from/to covering that day).
- cancel_event: cancel an event matching query (and optional from/to range).
- create_reminder: personal reminder (NOT a calendar event). Needs text + due. "tomorrow morning" = 09:00, "afternoon" = 14:00, "evening" = 18:00, "tonight" = 20:00. "30 minutes before it" refers to an event earlier in the same request: compute the absolute time.
- list_reminders / complete_reminder / delete_reminder.
- upload_file: Tony will pick the file and folder in the UI; capture folder_name / create_folder if he mentioned them.
- search_drive: find files; query = the key words only (e.g. "reactor design").
- open_drive: show Drive contents (optionally a folder).
- send_message: Telegram message. recipient = name as given. message = the actual text to send, rewritten from Tony's request in his voice (e.g. "send Bruce a message saying the experiment is postponed" -> "Hey Bruce, the experiment is postponed."). If the message is "about it"/"about the meeting", write a concrete message using details from the other steps (title, date, time).
- list_messages: communication history.

Rules:
- A request may need several steps; keep Tony's order.
- All datetimes: ISO 8601 with the timezone offset given below. Interpret relative dates against the current time given below. Times without am/pm: assume the next sensible occurrence during working hours.
- If a REQUIRED detail is missing or truly ambiguous (no time for an event or reminder, no recipient or no message content for a message, nothing to search for), set needs_clarification=true, ask ONE concise question, and return the steps you could not complete as an empty list. Previous turns are included: when Tony answers a question, merge his answer with the original request and return the full plan.
- Questions outside these capabilities: answer briefly in "reply" with no steps.
- reply: one or two crisp sentences in JARVIS's dry, polite British voice. Don't claim things are done — they haven't run yet; say what you are about to do.`;

// For providers without strict schema enforcement, spell the output format out.
const FORMAT_GUIDE = `

Respond with ONLY a JSON object of this shape (use null for fields that don't apply to a step):
{"reply": string, "needs_clarification": boolean, "clarification_question": string|null,
 "steps": [{"action": one of ${ACTIONS.join('|')}, "title", "start", "end", "description", "location",
   "text", "due", "query", "from", "to", "folder_name", "create_folder" (boolean), "recipient", "message"}]}`;

let anthropic = null;
const disabled = {}; // provider -> reason, set when a key is rejected

const CLAUDE_MODEL = process.env.JARVIS_MODEL || 'claude-opus-5-5';

// JARVIS_LLM=gemini|claude|rules forces a provider; otherwise the first configured one wins.
function provider() {
  if (process.env.JARVIS_DISABLE_LLM === '1') return null;
  const want = (process.env.JARVIS_LLM || '').toLowerCase();
  const available = {
    gemini: geminiConfigured() && !disabled.gemini,
    claude: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && !disabled.claude,
  };
  if (want === 'rules') return null;
  if (want && available[want]) return want;
  return ['gemini', 'claude'].find((p) => available[p]) || null;
}

export function llmStatus() {
  const p = provider();
  if (p === 'gemini') return { state: 'connected', provider: 'Gemini', model: geminiModel() };
  if (p === 'claude') return { state: 'connected', provider: 'Claude', model: CLAUDE_MODEL };
  const reason = Object.values(disabled)[0] || 'No AI API key (GEMINI_API_KEY or ANTHROPIC_API_KEY) — using built-in command parser.';
  return { state: 'fallback', reason };
}

function contextBlock(tz) {
  const now = new Date();
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const off = `${sign}${String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMin) % 60).padStart(2, '0')}`;
  const local = now.toLocaleString('en-GB', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const contacts = store.get('contacts').map((c) => c.name + (c.team ? ' (team)' : '')).join(', ') || 'none';
  return `Current time: ${local} (${tz}, UTC${off}). ISO now: ${now.toISOString()}.\nTelegram contacts: ${contacts}.`;
}

async function askClaude(messages) {
  anthropic ||= new Anthropic();
  const response = await anthropic.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
    system: SYSTEM,
    messages,
  });
  if (response.stop_reason === 'refusal') throw Object.assign(new Error('refused'), { refusal: true });
  return JSON.parse(response.content.find((b) => b.type === 'text').text);
}

const askGemini = (messages) => geminiJSON({ system: SYSTEM + FORMAT_GUIDE, messages, schema: PLAN_SCHEMA });

export async function plan({ text, history = [], pending }) {
  const tz = process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const p = provider();
  if (!p) return { ...ruleParse(pending ? `${pending} ${text}` : text), engine: 'rules' };

  const messages = [];
  for (const turn of history.slice(-10)) {
    if (!turn?.content) continue;
    const role = turn.role === 'assistant' ? 'assistant' : 'user';
    if (messages.length === 0 && role === 'assistant') continue;
    if (messages.at(-1)?.role === role) messages.at(-1).content += `\n${turn.content}`;
    else messages.push({ role, content: turn.content });
  }
  const userTurn = `${contextBlock(tz)}\n\nTony: ${text}`;
  if (messages.at(-1)?.role === 'user') messages.at(-1).content += `\n${userTurn}`;
  else messages.push({ role: 'user', content: userTurn });

  try {
    const parsed = p === 'gemini' ? await askGemini(messages) : await askClaude(messages);
    parsed.steps = (Array.isArray(parsed.steps) ? parsed.steps : [])
      .map(compact)
      .filter((s) => ACTIONS.includes(s.action));
    return { reply: parsed.reply || 'Very well, sir.', needs_clarification: Boolean(parsed.needs_clarification), clarification_question: parsed.clarification_question || null, steps: parsed.steps, engine: p };
  } catch (err) {
    if (err.refusal) {
      return { reply: "I'm afraid I can't help with that one, sir.", needs_clarification: false, steps: [], engine: p };
    }
    const rejected = p === 'claude'
      ? err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
      : [400, 401, 403].includes(err.status) && /api key|permission|unauthori[sz]ed/i.test(err.message);
    if (rejected) disabled[p] = `${p === 'gemini' ? 'Gemini' : 'Anthropic'} API key was rejected — using built-in command parser.`;
    console.warn(`[planner] ${p} unavailable, falling back to rules:`, err.message);
    const fallback = ruleParse(pending ? `${pending} ${text}` : text);
    return { ...fallback, engine: 'rules', notice: `AI core unreachable (${err.message.slice(0, 120)}) — used the onboard parser.` };
  }
}

// Drop null fields so steps are easy to read in the UI.
function compact(step) {
  return Object.fromEntries(Object.entries(step).filter(([, v]) => v !== null && v !== ''));
}
