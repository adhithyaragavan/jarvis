// Step executors. Each step goes through prepare() (validate, resolve targets,
// decide whether Tony must confirm) and then execute().
import * as g from './google.js';
import * as tg from './telegram.js';
import { store } from './store.js';
import { JarvisError, Codes, requireFields } from './errors.js';

const fmt = (d) =>
  new Date(d).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: process.env.TIMEZONE || undefined,
  });

const words = (q = '') => q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !['the', 'with', 'my', 'a', 'an', 'meeting', 'event'].includes(w));
const matches = (text, q) => {
  const w = words(q);
  const t = text.toLowerCase();
  return w.length === 0 || w.every((x) => t.includes(x));
};

function findReminders(query) {
  const all = store.get('reminders').filter((r) => !r.done);
  const hits = all.filter((r) => matches(r.text, query));
  if (!hits.length) throw new JarvisError(Codes.NOT_FOUND, `I couldn't find an active reminder matching "${query}".`);
  return hits;
}

export async function prepare(step) {
  switch (step.action) {
    case 'create_event':
      requireFields(step, ['title', 'start'], 'Calendar event');
      g.ensureGoogle();
      return {
        step,
        confirm: process.env.CONFIRM_EVENTS === '1'
          ? { title: 'Create calendar event?', detail: `${step.title} — ${fmt(step.start)}` }
          : null,
      };

    case 'cancel_event': {
      const from = step.from || new Date().toISOString();
      const to = step.to || new Date(Date.now() + 30 * 864e5).toISOString();
      const events = await g.listEvents({ from, to, max: 100 });
      const hits = events.filter((e) => matches(`${e.title} ${e.description}`, step.query || ''));
      if (!hits.length) {
        throw new JarvisError(Codes.NOT_FOUND, `No calendar event matching "${step.query || 'that'}" in that window, sir.`);
      }
      const target = hits[0];
      return {
        step: { ...step, eventId: target.id, eventTitle: target.title, eventStart: target.start },
        confirm: {
          title: 'Cancel calendar event?',
          detail: `${target.title} — ${fmt(target.start)}${hits.length > 1 ? ` (${hits.length} matches; this is the soonest)` : ''}`,
          danger: true,
        },
      };
    }

    case 'create_reminder':
      requireFields(step, ['text', 'due'], 'Reminder');
      if (Number.isNaN(+new Date(step.due))) throw new JarvisError(Codes.MISSING_FIELD, `"${step.due}" isn't a time I understand.`);
      return { step };

    case 'complete_reminder':
    case 'delete_reminder': {
      requireFields(step, ['query'], 'Reminder lookup');
      const [hit] = findReminders(step.query);
      const resolved = { ...step, reminderId: hit.id, reminderText: hit.text };
      return step.action === 'delete_reminder'
        ? { step: resolved, confirm: { title: 'Delete reminder?', detail: `${hit.text} — ${fmt(hit.due)}`, danger: true } }
        : { step: resolved };
    }

    case 'upload_file':
      // Make sure Drive is reachable before opening the upload console.
      await g.listAllFolders();
      return { step, ui: 'upload' };

    case 'search_drive':
      requireFields(step, ['query'], 'Drive search');
      return { step };

    case 'send_message': {
      requireFields(step, ['recipient', 'message'], 'Telegram message');
      if (!tg.telegramConfigured()) {
        throw new JarvisError(Codes.INTEGRATION_UNAVAILABLE, 'Telegram is offline — TELEGRAM_BOT_TOKEN is not configured.', { status: 503 });
      }
      const targets = tg.resolveRecipient(step.recipient);
      if (!targets) {
        const known = store.get('contacts').map((c) => c.name).join(', ') || 'none yet';
        throw new JarvisError(Codes.NOT_FOUND, `I don't have a Telegram contact called "${step.recipient}". Known contacts: ${known}.`, {
          hint: ['recipient'],
        });
      }
      return {
        step,
        confirm: {
          title: 'Send Telegram message?',
          detail: `To ${targets.map((t) => t.name).join(', ')}: “${step.message}”`,
          editable: 'message',
        },
      };
    }

    default:
      return { step };
  }
}

export async function execute(step) {
  switch (step.action) {
    case 'create_event': {
      const ev = await g.createEvent(step);
      return { summary: `Event created: ${ev.title} — ${fmt(ev.start)}.`, data: ev, preview: { tab: 'calendar', highlight: ev.id } };
    }

    case 'list_events': {
      const from = step.from || new Date().toISOString();
      const to = step.to || new Date(Date.now() + 7 * 864e5).toISOString();
      const events = await g.listEvents({ from, to, query: step.query });
      const summary = events.length
        ? `You have ${events.length} event${events.length > 1 ? 's' : ''}:\n` + events.map((e) => `• ${fmt(e.start)} — ${e.title}`).join('\n')
        : 'Your calendar is clear for that period, sir.';
      return { summary, data: events, preview: { tab: 'calendar', from, to } };
    }

    case 'cancel_event':
      await g.deleteEvent(step.eventId);
      return { summary: `Cancelled “${step.eventTitle}” (${fmt(step.eventStart)}).`, preview: { tab: 'calendar' } };

    case 'create_reminder': {
      const r = store.insert('reminders', { text: step.text, due: new Date(step.due).toISOString(), done: false, fired: false });
      return { summary: `Reminder set: ${r.text} — ${fmt(r.due)}.`, data: r, preview: { tab: 'reminders', highlight: r.id } };
    }

    case 'list_reminders': {
      let list = store.get('reminders').filter((r) => !r.done);
      if (step.from && step.to) {
        const [from, to] = [new Date(step.from), new Date(step.to)];
        list = list.filter((r) => new Date(r.due) >= from && new Date(r.due) < to);
      }
      list = [...list].sort((a, b) => a.due.localeCompare(b.due));
      const summary = list.length
        ? `${list.length} active reminder${list.length > 1 ? 's' : ''}:\n` + list.map((r) => `• ${fmt(r.due)} — ${r.text}`).join('\n')
        : `No active reminders${step.from ? ' for that period' : ''}, sir.`;
      return { summary, data: list, preview: { tab: 'reminders' } };
    }

    case 'complete_reminder': {
      const id = step.reminderId || findReminders(step.query)[0].id;
      const r = store.update('reminders', id, { done: true, completedAt: new Date().toISOString() });
      return { summary: `Marked “${r.text}” as done.`, preview: { tab: 'reminders' } };
    }

    case 'delete_reminder': {
      const r = store.remove('reminders', step.reminderId);
      if (!r) throw new JarvisError(Codes.NOT_FOUND, 'That reminder no longer exists.');
      return { summary: `Deleted reminder “${r.text}”.`, preview: { tab: 'reminders' } };
    }

    case 'search_drive': {
      const files = await g.searchFiles(step.query);
      const summary = files.length
        ? `Found ${files.length} file${files.length > 1 ? 's' : ''} for “${step.query}”. Top match: ${files[0].name} (${files[0].type}, in ${files[0].folder}).`
        : `Nothing in the Stark Archive matches “${step.query}”, sir.`;
      return { summary, data: files, preview: { tab: 'drive', search: step.query, results: files } };
    }

    case 'open_drive': {
      let folderId = 'root';
      if (step.folder_name) {
        const folders = await g.listAllFolders();
        const f = folders.find((x) => x.name.toLowerCase() === step.folder_name.toLowerCase()) ||
          folders.find((x) => matches(x.name, step.folder_name));
        if (!f) throw new JarvisError(Codes.NOT_FOUND, `No Drive folder called “${step.folder_name}”.`);
        folderId = f.id;
      }
      return { summary: 'Drive is up in the preview pane, sir.', preview: { tab: 'drive', folderId } };
    }

    case 'send_message': {
      const sent = await tg.sendMessage({ recipient: step.recipient, text: step.message });
      return {
        summary: `Message delivered to ${sent.map((m) => m.recipient).join(', ')} via Telegram.`,
        data: sent,
        preview: { tab: 'comms' },
      };
    }

    case 'list_messages': {
      const msgs = store.get('messages').slice(0, 10);
      const summary = msgs.length
        ? `Last ${msgs.length} transmissions:\n` + msgs.map((m) => `• ${m.recipient} — ${m.status} — “${m.text.slice(0, 50)}”`).join('\n')
        : 'No messages sent yet, sir.';
      return { summary, data: msgs, preview: { tab: 'comms' } };
    }

    default:
      throw new JarvisError(Codes.MISSING_FIELD, `I don't know how to perform "${step.action}".`);
  }
}

export const LABELS = {
  create_event: 'Calendar · Create event',
  list_events: 'Calendar · Read schedule',
  cancel_event: 'Calendar · Cancel event',
  create_reminder: 'Reminders · Create',
  list_reminders: 'Reminders · List',
  complete_reminder: 'Reminders · Complete',
  delete_reminder: 'Reminders · Delete',
  upload_file: 'Drive · Upload',
  search_drive: 'Drive · Search',
  open_drive: 'Drive · Browse',
  send_message: 'Telegram · Send',
  list_messages: 'Telegram · History',
};
