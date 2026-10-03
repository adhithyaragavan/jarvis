import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import * as g from './lib/google.js';
import * as tg from './lib/telegram.js';
import { plan, llmStatus } from './lib/planner.js';
import { prepare, execute, LABELS } from './lib/actions.js';
import { store } from './lib/store.js';
import { JarvisError, Codes } from './lib/errors.js';

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

/* ---------- live updates (SSE) ---------- */
const clients = new Set();
function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(line);
}
app.get('/api/stream', (req, res) => {
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

function logAction(entry) {
  const row = store.insert('actions', entry);
  broadcast({ type: 'refresh', scope: 'actions' });
  return row;
}

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    sendError(res, err);
  }
};
function sendError(res, err) {
  if (!(err instanceof JarvisError)) console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    error: { code: err.code || 'INTERNAL', message: err.message || 'Unknown failure', hint: err.hint },
  });
}

/* ---------- status ---------- */
app.get('/api/status', wrap(async () => ({
  online: true,
  google: g.googleStatus(),
  telegram: await tg.telegramStatus(),
  ai: llmStatus(),
  ownerNotifications: Boolean(process.env.TELEGRAM_OWNER_CHAT_ID),
})));

/* ---------- Google OAuth ---------- */
app.get('/auth/google', (req, res) => {
  try {
    res.redirect(g.authUrl());
  } catch (err) {
    res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});
app.get('/auth/google/callback', async (req, res) => {
  if (req.query.error) return res.redirect(`/?auth_error=${encodeURIComponent(req.query.error)}`);
  try {
    await g.handleCallback(req.query.code);
    logAction({ kind: 'system', label: 'Google · Connected', summary: 'Google account authorised.', status: 'success' });
    broadcast({ type: 'status' });
    res.redirect('/?auth=google');
  } catch (err) {
    res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});
app.post('/api/google/disconnect', wrap(async () => {
  g.disconnect();
  broadcast({ type: 'status' });
  return { ok: true };
}));

/* ---------- command pipeline ---------- */
app.post('/api/plan', wrap(async (req) => {
  const { text, history, pending } = req.body || {};
  if (!text?.trim()) throw new JarvisError(Codes.MISSING_FIELD, 'Empty command.');
  return plan({ text: text.trim(), history, pending });
}));

app.post('/api/prepare', wrap(async (req) => prepare(req.body.step)));

app.post('/api/execute', async (req, res) => {
  const { step, commandId } = req.body || {};
  const label = LABELS[step?.action] || step?.action;
  try {
    const result = await execute(step);
    logAction({ kind: step.action, label, summary: result.summary.split('\n')[0], status: 'success', commandId });
    if (result.preview?.tab) broadcast({ type: 'refresh', scope: result.preview.tab });
    res.json(result);
  } catch (err) {
    logAction({ kind: step?.action, label, summary: err.message, status: 'failed', code: err.code, commandId });
    if (step?.action === 'send_message') broadcast({ type: 'refresh', scope: 'comms' });
    sendError(res, err);
  }
});

// The UI records actions that never reached execute (cancelled, declined, interrupted).
app.post('/api/actions/log', wrap(async (req) => {
  const { action, status, summary, commandId } = req.body;
  return logAction({ kind: action, label: LABELS[action] || action, summary, status, commandId });
}));
app.get('/api/actions', wrap(async () => store.get('actions').slice(0, 100)));

/* ---------- calendar ---------- */
app.get('/api/calendar', wrap(async (req) => {
  const from = req.query.from || new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const to = req.query.to || new Date(Date.now() + 14 * 864e5).toISOString();
  return g.listEvents({ from, to, max: 100 });
}));

/* ---------- reminders ---------- */
app.get('/api/reminders', wrap(async () =>
  [...store.get('reminders')].sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due))
));
app.post('/api/reminders/:id/done', wrap(async (req) => {
  const r = store.update('reminders', req.params.id, { done: true, completedAt: new Date().toISOString() });
  if (!r) throw new JarvisError(Codes.NOT_FOUND, 'Reminder not found.', { status: 404 });
  logAction({ kind: 'complete_reminder', label: LABELS.complete_reminder, summary: `Marked “${r.text}” as done.`, status: 'success' });
  broadcast({ type: 'refresh', scope: 'reminders' });
  return r;
}));
app.post('/api/reminders/:id/snooze', wrap(async (req) => {
  const mins = Number(req.body?.minutes) || 10;
  const r = store.update('reminders', req.params.id, { due: new Date(Date.now() + mins * 60e3).toISOString(), fired: false });
  if (!r) throw new JarvisError(Codes.NOT_FOUND, 'Reminder not found.', { status: 404 });
  logAction({ kind: 'create_reminder', label: 'Reminders · Snooze', summary: `Snoozed “${r.text}” by ${mins} min.`, status: 'success' });
  broadcast({ type: 'refresh', scope: 'reminders' });
  return r;
}));
app.delete('/api/reminders/:id', wrap(async (req) => {
  const r = store.remove('reminders', req.params.id);
  if (!r) throw new JarvisError(Codes.NOT_FOUND, 'Reminder not found.', { status: 404 });
  logAction({ kind: 'delete_reminder', label: LABELS.delete_reminder, summary: `Deleted reminder “${r.text}”.`, status: 'success' });
  broadcast({ type: 'refresh', scope: 'reminders' });
  return r;
}));

// Reminder scheduler: fires due reminders to the UI (and Tony's Telegram if configured).
setInterval(async () => {
  const now = new Date().toISOString();
  for (const r of store.get('reminders')) {
    if (r.done || r.fired || r.due > now) continue;
    store.update('reminders', r.id, { fired: true, firedAt: now });
    const pinged = await tg.notifyOwner(`⏰ JARVIS reminder: ${r.text}`);
    broadcast({ type: 'reminder_due', reminder: r, telegram: pinged });
    broadcast({ type: 'refresh', scope: 'reminders' });
  }
}, 10_000);

/* ---------- drive ---------- */
app.get('/api/drive/list', wrap(async (req) => g.listFolder(req.query.folderId || 'root')));
app.get('/api/drive/folders', wrap(async () => g.listAllFolders()));
app.get('/api/drive/search', wrap(async (req) => g.searchFiles(req.query.q)));
app.post('/api/drive/folders', wrap(async (req) => {
  const folder = await g.createFolder(req.body.name?.trim(), req.body.parentId);
  logAction({ kind: 'upload_file', label: 'Drive · New folder', summary: `Created folder “${folder.name}”.`, status: 'success' });
  broadcast({ type: 'refresh', scope: 'drive' });
  return folder;
}));
app.post('/api/drive/upload', (req, res) => {
  upload.single('file')(req, res, async (multerErr) => {
    const label = LABELS.upload_file;
    try {
      if (multerErr) {
        throw new JarvisError(Codes.UPLOAD_FAILED, multerErr.code === 'LIMIT_FILE_SIZE' ? 'That file exceeds the 50 MB uplink limit.' : multerErr.message);
      }
      if (!req.file) throw new JarvisError(Codes.MISSING_FIELD, 'No document was attached for upload.');
      let folderId = req.body.folderId || 'root';
      let folderLabel = req.body.folderName || 'My Drive';
      if (req.body.newFolderName?.trim()) {
        const created = await g.createFolder(req.body.newFolderName.trim(), folderId);
        folderId = created.id;
        folderLabel = created.name;
      }
      const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const file = await g.uploadFile({ buffer: req.file.buffer, name, mimeType: req.file.mimetype, folderId });
      const summary = `Uploaded “${file.name}” to ${folderLabel}.`;
      logAction({ kind: 'upload_file', label, summary, status: 'success', commandId: req.body.commandId });
      broadcast({ type: 'refresh', scope: 'drive' });
      res.json({ summary, data: file, preview: { tab: 'drive', folderId, highlight: file.id } });
    } catch (err) {
      logAction({ kind: 'upload_file', label, summary: err.message, status: 'failed', code: err.code, commandId: req.body?.commandId });
      sendError(res, err);
    }
  });
});

/* ---------- telegram ---------- */
app.get('/api/messages', wrap(async () => store.get('messages').slice(0, 100)));
app.get('/api/contacts', wrap(async () => store.get('contacts')));
app.post('/api/contacts', wrap(async (req) => {
  const { name, chatId, team, aliases } = req.body || {};
  if (!name?.trim() || !String(chatId || '').trim()) throw new JarvisError(Codes.MISSING_FIELD, 'A contact needs a name and a Telegram chat ID.');
  const c = store.upsertContact({
    name: name.trim(),
    chatId: String(chatId).trim(),
    team: Boolean(team),
    aliases: (aliases || []).filter(Boolean),
  });
  broadcast({ type: 'refresh', scope: 'contacts' });
  return c;
}));
app.patch('/api/contacts/:id', wrap(async (req) => {
  const c = store.update('contacts', req.params.id, { team: Boolean(req.body.team) });
  broadcast({ type: 'refresh', scope: 'contacts' });
  return c;
}));
app.delete('/api/contacts/:id', wrap(async (req) => {
  store.remove('contacts', req.params.id);
  broadcast({ type: 'refresh', scope: 'contacts' });
  return { ok: true };
}));
app.post('/api/contacts/sync', wrap(async () => {
  const found = await tg.syncContacts();
  broadcast({ type: 'refresh', scope: 'contacts' });
  return found;
}));

app.listen(PORT, () => {
  console.log(`\n  ⟁ JARVIS online → http://localhost:${PORT}\n`);
  console.log(`  AI core:  ${llmStatus().state}`);
  console.log(`  Google:   ${g.googleStatus().state}`);
  console.log(`  Telegram: ${tg.telegramConfigured() ? 'configured' : 'unconfigured'}\n`);
});
