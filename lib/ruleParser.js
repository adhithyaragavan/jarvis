// Offline command parser: keeps JARVIS useful with no LLM configured.
// Produces the same plan shape as the Claude planner.
import * as chrono from 'chrono-node';

const VERBS =
  'schedule|book|set up|arrange|create|add|plan|remind|send|message|text|tell|notify|ping|upload|save|put|find|search|locate|look for|show|list|what|cancel|delete|remove|open|mark|complete';
const SPLIT = new RegExp(
  `\\s*(?:,\\s*(?:and\\s+)?(?:then\\s+)?|\\band\\s+(?:then\\s+)?|;\\s*|\\bthen\\s+|\\.\\s+)(?=(?:also\\s+)?(?:${VERBS})\\b)`,
  'i'
);

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s) => s.replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').trim();

const PART_OF_DAY = [
  [/\btomorrow morning\b/i, 'tomorrow at 9am'],
  [/\bthis morning\b/i, 'today at 9am'],
  [/\b(tomorrow|today) afternoon\b/i, '$1 at 2pm'],
  [/\b(tomorrow|today) evening\b/i, '$1 at 6pm'],
  [/\btomorrow night\b/i, 'tomorrow at 8pm'],
  [/\btonight\b/i, 'today at 8pm'],
];

function parseWhen(text, ref = new Date()) {
  let t = text;
  for (const [re, rep] of PART_OF_DAY) t = t.replace(re, rep);
  const results = chrono.parse(t, ref, { forwardDate: true });
  if (!results.length) return null;
  const r = results[0];
  const hasTime = r.start.isCertain('hour');
  return {
    start: r.start.date(),
    end: r.end?.date() || null,
    hasTime,
    hasDay: r.start.isCertain('day') || r.start.isCertain('weekday'),
    matched: r.text,
    // the matched text may differ from the original after PART_OF_DAY rewrites
    strip: (s) => {
      let out = s;
      for (const [re] of PART_OF_DAY) out = out.replace(re, '');
      return out.replace(r.text, '').replace(new RegExp(r.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '');
    },
  };
}

function dayRange(text) {
  const now = new Date();
  const w = parseWhen(text, now);
  let from, to;
  if (/\bthis week\b/i.test(text)) {
    from = now;
    to = new Date(+now + 7 * 864e5);
  } else if (/\bnext week\b/i.test(text)) {
    from = new Date(+now + 7 * 864e5);
    to = new Date(+now + 14 * 864e5);
  } else if (w) {
    from = new Date(w.start);
    from.setHours(0, 0, 0, 0);
    to = new Date(+from + 864e5);
    if (from < now && /today/i.test(text)) from = new Date(now.setHours(0, 0, 0, 0));
  }
  return from ? { from: from.toISOString(), to: to.toISOString() } : {};
}

function parseClause(raw, ctx) {
  const s = clean(raw.replace(/^(hey |ok |okay )?jarvis[,:]?\s*/i, '').replace(/^(please|also|could you|can you)\s+/i, ''));
  const lower = s.toLowerCase();

  // ---- reminders ----
  if (/\b(what|which|show|list|any)\b.*\breminders?\b|\breminders?\b.*\b(today|tomorrow|pending|active)\??$/i.test(s) && !/^remind me/i.test(s)) {
    return { step: { action: 'list_reminders', ...dayRange(s) } };
  }
  if (/^(mark|complete|tick off)\b.*\b(reminder|done|complete)/i.test(s)) {
    const query = clean(s.replace(/^(mark|complete|tick off)\s+(the\s+)?/i, '').replace(/\b(reminder|as done|as complete|done|complete)\b/gi, ''));
    return { step: { action: 'complete_reminder', query } };
  }
  if (/^(delete|remove|cancel)\b.*\breminder\b/i.test(s)) {
    const query = clean(s.replace(/^(delete|remove|cancel)\s+(the\s+|my\s+)?/i, '').replace(/\breminder\b(\s+(about|to|for))?/gi, ''));
    return { step: { action: 'delete_reminder', query } };
  }
  if (/\bremind\b|\breminder\b/i.test(s)) {
    let body = s.replace(/^(set\s+(a\s+)?reminder\s+(to|for|about)?|remind\s+me\s*(?:(?:to|about|of)\b)?)\s*/i, '');
    const rel = body.match(/\b(\d+)\s*(min|mins|minutes|hour|hours|hr|hrs)\s+before\s+(it|that|the meeting|the event)\b/i);
    let due = null;
    if (rel) {
      body = body.replace(rel[0], '');
      const base = ctx.lastEventStart;
      if (base) due = new Date(+base - Number(rel[1]) * (/^h/i.test(rel[2]) ? 3600e3 : 60e3));
      if (!body.trim() && ctx.lastEventTitle) body = ctx.lastEventTitle;
    } else {
      const w = parseWhen(body);
      if (w) {
        if (!w.hasTime) w.start.setHours(9, 0, 0, 0);
        due = w.start;
        body = w.strip(body);
      }
    }
    const text = cap(clean(clean(body).replace(/\b(at|on|by|about|for)\s*$/i, '').replace(/^(to|about|of|that)\s+/i, '')));
    if (!text) return { question: 'What should I remind you about, sir?' };
    if (!due) return { question: `When should I remind you to ${text.charAt(0).toLowerCase() + text.slice(1)}?` };
    return { step: { action: 'create_reminder', text, due: due.toISOString() } };
  }

  // ---- messaging ----
  if (/\b(message history|messages? (i|you) sent|sent messages|communication|comms log|recent messages)\b/i.test(s)) {
    return { step: { action: 'list_messages' } };
  }
  if (/^(send|message|text|tell|notify|ping|telegram|inform|let)\b/i.test(s)) {
    let recipient = null;
    let msg = null;
    const m =
      s.match(/^send\s+(?:a\s+)?(?:telegram\s+)?(?:message|msg|text|note)\s+to\s+(.+?)(?:\s+(?:saying|that says|that|telling (?:him|her|them)|to say|:)\s*(.+)|\s+about\s+(.+))?$/i) ||
      s.match(/^send\s+(.+?)\s+(?:a\s+)?(?:telegram\s+)?(?:message|msg|text|note)(?:\s+(?:saying|that says|that|telling (?:him|her|them)|to say|:)\s*(.+)|\s+about\s+(.+))?$/i) ||
      s.match(/^(?:message|text|ping|telegram|tell)\s+(.+?)\s+and\s+let\s+(?:him|her|them)\s+know\s+(?:that\s+)?(.+)$/i) ||
      s.match(/^(?:message|text|ping|telegram)\s+(.+?)(?:\s*(?::|saying|that|to say)\s*(.+)|\s+about\s+(.+))?$/i) ||
      s.match(/^(?:tell|notify|inform)\s+(.+?)(?:\s+(?:that|:)\s*(.+)|\s+about\s+(.+))?$/i) ||
      s.match(/^let\s+(.+?)\s+know\s+(?:that\s+)?(.+)$/i);
    if (m) {
      recipient = clean(m[1].replace(/^(the\s+)?/i, (x) => (/team/i.test(m[1]) ? '' : x)));
      msg = m[2] ? clean(m[2]) : null;
      const about = m[3] ? clean(m[3]) : null;
      if (!msg && about) {
        if (/^(it|this|that|the meeting|the event)$/i.test(about) && ctx.lastEventTitle) {
          msg = `Heads up: "${ctx.lastEventTitle}" is scheduled for ${fmt(ctx.lastEventStart)}.`;
        } else msg = cap(about);
      }
    }
    if (recipient && /^(the )?team$/i.test(recipient)) recipient = 'team';
    if (!recipient) return { question: 'Who should I send the message to, sir?' };
    if (!msg) return { question: `What would you like me to tell ${recipient === 'team' ? 'the team' : recipient}?`, partial: { recipient } };
    msg = cap(msg.replace(/\bmy\b/gi, 'my'));
    if (!/[.!?]$/.test(msg)) msg += '.';
    return { step: { action: 'send_message', recipient, message: msg } };
  }

  // ---- drive ----
  if (/\b(upload|save|put|store|archive)\b/i.test(s) && /\b(drive|archive|folder|upload)\b/i.test(s)) {
    const folder = s.match(/\b(?:to|in|into|under)\s+(?:the\s+|my\s+|a\s+)?(new\s+)?folder\s+(?:called\s+|named\s+)?["“']?([^"”']+?)["”']?$/i) ||
      s.match(/\b(?:to|in|into)\s+(?:the\s+|my\s+)?["“']?([^"”']+?)["”']?\s+folder\b/i);
    const step = { action: 'upload_file' };
    if (folder) {
      step.folder_name = clean(folder[2] || folder[1]);
      step.create_folder = /new folder/i.test(s);
    }
    return { step };
  }
  if (/^(find|search|locate|look for|where is|where's|get me|pull up)\b/i.test(s)) {
    const query = clean(
      s.replace(/^(find|search( for)?|locate|look for|where is|where's|get me|pull up)\s+/i, '')
        .replace(/\b(in|on|from)\s+(my\s+)?(google\s+)?drive\b/gi, '')
        .replace(/^(the|my|a|an)\s+/i, '')
        .replace(/\b(file|document|doc)s?\b$/i, '')
    );
    if (!query) return { question: 'What should I search the Stark Archive for?' };
    return { step: { action: 'search_drive', query } };
  }
  if (/\b(show|open|browse|display)\b.*\bdrive\b/i.test(s)) {
    return { step: { action: 'open_drive' } };
  }

  // ---- calendar ----
  if (/^(cancel|delete|remove|clear)\b/i.test(s)) {
    const range = dayRange(s);
    const w = parseWhen(s);
    let query = clean((w ? w.strip(s) : s).replace(/^(cancel|delete|remove|clear)\s+(the\s+|my\s+)?/i, '').replace(/\b(meeting|event|appointment)\b(\s+with)?/i, (x) => (/with/.test(x) ? 'with' : '')));
    query = query.replace(/^with\s+/i, '');
    if (!query && !range.from) return { question: 'Which event should I cancel, sir?' };
    return { step: { action: 'cancel_event', query, ...range } };
  }
  if (/\b(what('s| is| do i have)|anything|show|list|agenda|schedule for|scheduled|upcoming|calendar|am i free|free)\b/i.test(s) && !/^(schedule|book|set up|arrange|create|add|plan)\b/i.test(s)) {
    const range = dayRange(s);
    return { step: { action: 'list_events', ...range } };
  }
  if (/^(schedule|book|set up|arrange|create|add|plan|organi[sz]e|put)\b/i.test(s) || /\b(meeting|call|appointment|event|briefing|session|dinner|lunch)\b/i.test(s)) {
    const w = parseWhen(s);
    let body = w ? w.strip(s) : s;
    let description = null;
    const d = body.match(/\s+(?:about|regarding|to discuss|re:|with (?:the )?description)\s+(.+)$/i);
    if (d && !/^(it|this)$/i.test(d[1])) {
      description = cap(clean(d[1]));
      body = body.replace(d[0], '');
    }
    let title = clean(
      body.replace(/^(schedule|book|set up|arrange|create|add|plan|organi[sz]e|put)\s+/i, '')
        .replace(/\b(to|on|in)\s+(my\s+)?calendar\b/i, '')
        .replace(/^(a|an|the|my)\s+/i, '')
        .replace(/\b(for|at|on)\s*$/i, '')
    );
    title = cap(title || 'Meeting');
    if (!w) return { question: `When should I schedule "${title}", sir?` };
    if (!w.hasTime) return { question: `What time on ${w.start.toDateString()} should "${title}" start?` };
    const end = w.end || new Date(+w.start + 3600e3);
    ctx.lastEventStart = w.start;
    ctx.lastEventTitle = title;
    return { step: { action: 'create_event', title, start: w.start.toISOString(), end: end.toISOString(), ...(description && { description }) } };
  }

  return null;
}

const fmt = (d) =>
  d
    ? new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'the scheduled time';

const REPLIES = {
  create_event: (s) => `scheduling "${s.title}" for ${fmt(s.start)}`,
  list_events: () => 'pulling up your calendar',
  cancel_event: (s) => `locating ${s.query ? `"${s.query}"` : 'that event'} to cancel`,
  create_reminder: (s) => `setting a reminder ("${s.text}") for ${fmt(s.due)}`,
  list_reminders: () => 'checking your reminders',
  complete_reminder: (s) => `marking "${s.query}" as done`,
  delete_reminder: (s) => `removing the "${s.query}" reminder`,
  upload_file: () => 'opening the Stark Archive uplink',
  search_drive: (s) => `searching the Stark Archive for "${s.query}"`,
  open_drive: () => 'opening your Drive',
  send_message: (s) => `drafting a Telegram message to ${s.recipient}`,
  list_messages: () => 'retrieving communication logs',
};

export function ruleParse(text) {
  const t = text.trim();
  if (/^(hi|hello|hey|good (morning|evening|afternoon)|yo)\b[\s!.,]*(jarvis)?[\s!.]*$/i.test(t)) {
    return { reply: 'At your service, sir. All systems are online.', needs_clarification: false, steps: [] };
  }
  if (/^(status|systems? (check|status)|diagnostics?)\b/i.test(t)) {
    return { reply: 'Running diagnostics — integration status is shown in the header, sir.', needs_clarification: false, steps: [] };
  }
  if (/^(help|what can you do)/i.test(t)) {
    return {
      reply: 'I can schedule events, set reminders, upload and find documents in Drive, and send Telegram messages — individually or all at once. Try: "Schedule the Stark team meeting tomorrow at 6 PM, remind me 30 minutes before it, and send Bruce a message about it."',
      needs_clarification: false,
      steps: [],
    };
  }
  const clauses = t.split(SPLIT).filter(Boolean);
  const ctx = {};
  const steps = [];
  for (const c of clauses) {
    const r = parseClause(c, ctx);
    if (!r) continue;
    if (r.question) return { reply: r.question, needs_clarification: true, clarification_question: r.question, steps: [] };
    steps.push(r.step);
  }
  if (!steps.length) {
    return {
      reply: "I'm not certain what you'd like me to do, sir. I can manage your calendar, reminders, Drive and Telegram — try “help”.",
      needs_clarification: true,
      clarification_question: null,
      steps: [],
    };
  }
  const parts = steps.map((s) => REPLIES[s.action](s));
  const reply = `Right away, sir — ${parts.length > 1 ? parts.slice(0, -1).join(', ') + ', then ' + parts.at(-1) : parts[0]}.`;
  return { reply, needs_clarification: false, clarification_question: null, steps };
}
