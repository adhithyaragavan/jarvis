// Telegram Bot API. Bots can only message people who have pressed /start on the
// bot, so contacts are discovered from getUpdates and stored by name.
import { JarvisError, Codes, requireFields } from './errors.js';
import { store } from './store.js';

const token = () => process.env.TELEGRAM_BOT_TOKEN;
export const telegramConfigured = () => Boolean(token());

let botInfo = null;
let lastError = null;

async function api(method, body) {
  if (!telegramConfigured()) {
    throw new JarvisError(
      Codes.INTEGRATION_UNAVAILABLE,
      'Telegram is offline — TELEGRAM_BOT_TOKEN is not configured.',
      { status: 503 }
    );
  }
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    lastError = err.message;
    throw new JarvisError(Codes.SEND_FAILED, `Telegram is unreachable: ${err.message}`, { status: 502 });
  }
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    lastError = json.description;
    if (res.status === 401) {
      throw new JarvisError(Codes.AUTH_EXPIRED, 'Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN.', { status: 401 });
    }
    throw new JarvisError(Codes.SEND_FAILED, `Telegram error: ${json.description || res.statusText}`, { status: 502 });
  }
  lastError = null;
  return json.result;
}

export async function telegramStatus() {
  if (!telegramConfigured()) return { state: 'unconfigured' };
  try {
    botInfo ||= await api('getMe');
    return { state: 'connected', bot: botInfo.username };
  } catch (err) {
    return { state: err.code === Codes.AUTH_EXPIRED ? 'expired' : 'error', error: err.message };
  }
}

// Pull anyone who has messaged the bot into the contact book.
export async function syncContacts() {
  const updates = await api('getUpdates', { limit: 100, allowed_updates: ['message'] });
  const found = [];
  for (const u of updates) {
    const chat = u.message?.chat;
    if (!chat || chat.type !== 'private') continue;
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username;
    found.push(store.upsertContact({ name, username: chat.username || '', chatId: chat.id }));
  }
  return found;
}

export function resolveRecipient(name) {
  if (!name) return null;
  const n = name.toLowerCase().replace(/^@/, '').trim();
  const contacts = store.get('contacts');
  if (['team', 'everyone', 'the team', 'all'].includes(n)) {
    const team = contacts.filter((c) => c.team);
    return team.length ? team : null;
  }
  const hit =
    contacts.find((c) => c.name.toLowerCase() === n || c.username?.toLowerCase() === n) ||
    contacts.find((c) => (c.aliases || []).some((a) => a.toLowerCase() === n)) ||
    contacts.find((c) => c.name.toLowerCase().split(/\s+/).includes(n)) ||
    contacts.find((c) => c.name.toLowerCase().includes(n));
  return hit ? [hit] : null;
}

export async function sendMessage({ recipient, text }) {
  requireFields({ recipient, text }, ['recipient', 'text'], 'Telegram message');
  const targets = resolveRecipient(recipient);
  if (!targets) {
    const known = store.get('contacts').map((c) => c.name).join(', ') || 'none yet';
    throw new JarvisError(
      Codes.NOT_FOUND,
      `I don't have a Telegram contact called "${recipient}". Known contacts: ${known}.`,
      { hint: ['recipient'] }
    );
  }
  const results = [];
  for (const c of targets) {
    const log = store.insert('messages', {
      recipient: c.name,
      chatId: c.chatId,
      text,
      status: 'sending',
      via: 'JARVIS',
    });
    try {
      const sent = await api('sendMessage', { chat_id: c.chatId, text });
      results.push(store.update('messages', log.id, { status: 'delivered', telegramId: sent.message_id, sentAt: new Date().toISOString() }));
    } catch (err) {
      store.update('messages', log.id, { status: 'failed', error: err.message });
      throw err;
    }
  }
  return results;
}

// Used for reminder notifications to Tony himself, never throws.
export async function notifyOwner(text) {
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!chatId || !telegramConfigured()) return false;
  try {
    await api('sendMessage', { chat_id: chatId, text });
    return true;
  } catch {
    return false;
  }
}
