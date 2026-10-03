// Google OAuth + Calendar + Drive. Tokens persist in data/google-tokens.json so
// Tony only has to authorise once.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { JarvisError, Codes, requireFields } from './errors.js';

const TOKEN_FILE = path.resolve('data/google-tokens.json');
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'openid',
  'email',
  'profile',
];
const FOLDER_MIME = 'application/vnd.google-apps.folder';

let oauth = null;
let authExpired = false;
let profile = null;

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function client() {
  if (!googleConfigured()) {
    throw new JarvisError(
      Codes.INTEGRATION_UNAVAILABLE,
      'Google integration is offline — GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured.',
      { status: 503 }
    );
  }
  if (!oauth) {
    oauth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/google/callback`
    );
    try {
      oauth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
    } catch {}
    oauth.on('tokens', (tokens) => {
      const merged = { ...oauth.credentials, ...tokens };
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(merged, null, 2));
    });
  }
  return oauth;
}

export function googleStatus() {
  if (!googleConfigured()) return { state: 'unconfigured' };
  const c = client();
  if (!c.credentials?.refresh_token && !c.credentials?.access_token) return { state: 'disconnected' };
  if (authExpired) return { state: 'expired' };
  return { state: 'connected', email: profile?.email };
}

export function authUrl() {
  return client().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
}

export async function handleCallback(code) {
  const c = client();
  const { tokens } = await c.getToken(code);
  c.setCredentials(tokens);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  authExpired = false;
  await loadProfile().catch(() => {});
}

export function disconnect() {
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
  if (oauth) oauth.setCredentials({});
  profile = null;
  authExpired = false;
}

async function loadProfile() {
  const { data } = await google.oauth2({ version: 'v2', auth: client() }).userinfo.get();
  profile = data;
}

export function ensureGoogle() {
  authed();
}

function authed() {
  const c = client();
  if (!c.credentials?.refresh_token && !c.credentials?.access_token) {
    throw new JarvisError(Codes.AUTH_EXPIRED, 'Google is not connected. Authorise JARVIS to access your Google account.', {
      status: 401,
    });
  }
  return c;
}

// Translate googleapis failures into JarvisErrors with sensible codes.
async function call(fallbackCode, what, fn) {
  try {
    const result = await fn();
    authExpired = false;
    if (!profile) loadProfile().catch(() => {});
    return result;
  } catch (err) {
    if (err instanceof JarvisError) throw err;
    const status = err.code || err.response?.status;
    const reason = err.response?.data?.error;
    if (reason === 'invalid_grant' || status === 401) {
      authExpired = true;
      throw new JarvisError(Codes.AUTH_EXPIRED, 'Google authorisation has expired. Please reconnect Google.', { status: 401 });
    }
    const detail = err.errors?.[0]?.message || err.message;
    throw new JarvisError(fallbackCode, `${what}: ${detail}`, { status: 502 });
  }
}

/* ---------------- Calendar ---------------- */

const cal = () => google.calendar({ version: 'v3', auth: authed() });
const TZ = () => process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

const shapeEvent = (e) => ({
  id: e.id,
  title: e.summary || '(untitled)',
  description: e.description || '',
  start: e.start?.dateTime || e.start?.date,
  end: e.end?.dateTime || e.end?.date,
  allDay: Boolean(e.start?.date),
  link: e.htmlLink,
  location: e.location || '',
});

export async function listEvents({ from, to, query, max = 50 } = {}) {
  return call(Codes.CALENDAR_FAILED, 'Could not read the calendar', async () => {
    const { data } = await cal().events.list({
      calendarId: 'primary',
      timeMin: from || new Date().toISOString(),
      timeMax: to,
      q: query || undefined,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: max,
    });
    return data.items.map(shapeEvent);
  });
}

export async function createEvent({ title, start, end, description, location, attendees }) {
  requireFields({ title, start }, ['title', 'start'], 'Calendar event');
  const startDate = new Date(start);
  if (Number.isNaN(+startDate)) throw new JarvisError(Codes.MISSING_FIELD, `"${start}" is not a valid date/time.`);
  const endDate = end ? new Date(end) : new Date(+startDate + 60 * 60 * 1000);
  return call(Codes.CALENDAR_FAILED, 'The calendar event could not be created', async () => {
    const { data } = await cal().events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: title,
        description: description || undefined,
        location: location || undefined,
        start: { dateTime: startDate.toISOString(), timeZone: TZ() },
        end: { dateTime: endDate.toISOString(), timeZone: TZ() },
        attendees: attendees?.filter((a) => a.includes('@')).map((email) => ({ email })),
      },
    });
    return shapeEvent(data);
  });
}

export async function deleteEvent(eventId) {
  return call(Codes.CALENDAR_FAILED, 'The calendar event could not be cancelled', async () => {
    await cal().events.delete({ calendarId: 'primary', eventId });
    return { id: eventId };
  });
}

/* ---------------- Drive ---------------- */

const drive = () => google.drive({ version: 'v3', auth: authed() });
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,iconLink,parents';

const folderNameCache = new Map();
async function folderName(folderId) {
  if (!folderId) return 'My Drive';
  if (folderNameCache.has(folderId)) return folderNameCache.get(folderId);
  try {
    const { data } = await drive().files.get({ fileId: folderId, fields: 'id,name,parents' });
    const name = data.parents ? data.name : 'My Drive';
    folderNameCache.set(folderId, name);
    return name;
  } catch {
    return 'Shared / unknown';
  }
}

async function shapeFile(f) {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    type: friendlyType(f.mimeType),
    isFolder: f.mimeType === FOLDER_MIME,
    modifiedTime: f.modifiedTime,
    size: f.size ? Number(f.size) : null,
    link: f.webViewLink,
    folderId: f.parents?.[0] || null,
    folder: await folderName(f.parents?.[0]),
  };
}

function friendlyType(mime = '') {
  const map = {
    [FOLDER_MIME]: 'Folder',
    'application/pdf': 'PDF',
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
    'text/plain': 'Text',
    'text/markdown': 'Markdown',
    'application/zip': 'Archive',
  };
  if (map[mime]) return map[mime];
  if (mime.startsWith('image/')) return 'Image';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  return mime.split('/').pop() || 'File';
}

export async function listFolder(folderId = 'root') {
  return call(Codes.DRIVE_FAILED, 'Could not read Google Drive', async () => {
    const { data } = await drive().files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: `files(${FILE_FIELDS})`,
      orderBy: 'folder,modifiedTime desc',
      pageSize: 100,
    });
    let crumbs = [{ id: 'root', name: 'My Drive' }];
    if (folderId !== 'root') {
      const trail = [];
      let cur = folderId;
      for (let i = 0; i < 8 && cur; i++) {
        const { data: f } = await drive().files.get({ fileId: cur, fields: 'id,name,parents' });
        if (!f.parents) break; // reached My Drive root
        trail.unshift({ id: f.id, name: f.name });
        cur = f.parents[0];
      }
      crumbs = crumbs.concat(trail);
    }
    return { folderId, crumbs, files: await Promise.all(data.files.map(shapeFile)) };
  });
}

export async function listAllFolders() {
  return call(Codes.DRIVE_FAILED, 'Could not list Drive folders', async () => {
    const { data } = await drive().files.list({
      q: `mimeType = '${FOLDER_MIME}' and trashed = false and 'me' in owners`,
      fields: 'files(id,name,parents)',
      orderBy: 'name',
      pageSize: 200,
    });
    return data.files.map((f) => ({ id: f.id, name: f.name, parentId: f.parents?.[0] }));
  });
}

export async function createFolder(name, parentId = 'root') {
  requireFields({ name }, ['name'], 'New folder');
  return call(Codes.DRIVE_FAILED, 'The folder could not be created', async () => {
    const { data } = await drive().files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId || 'root'] },
      fields: FILE_FIELDS,
    });
    return shapeFile(data);
  });
}

export async function uploadFile({ buffer, name, mimeType, folderId = 'root' }) {
  if (!buffer?.length) throw new JarvisError(Codes.MISSING_FIELD, 'No document was attached for upload.');
  return call(Codes.UPLOAD_FAILED, 'Upload to Drive failed', async () => {
    const { data } = await drive().files.create({
      requestBody: { name, parents: [folderId || 'root'] },
      media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from(buffer) },
      fields: FILE_FIELDS,
    });
    return shapeFile(data);
  });
}

export async function searchFiles(query) {
  requireFields({ query }, ['query'], 'Drive search');
  const esc = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // Match on any significant word so "reactor design report" still finds
  // "Arc Reactor – Design v3.pdf".
  const words = esc.split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()));
  const nameClauses = (words.length ? words : [esc]).map((w) => `name contains '${w}'`);
  const q = `trashed = false and (${nameClauses.join(' or ')} or fullText contains '${esc}')`;
  return call(Codes.DRIVE_FAILED, 'Drive search failed', async () => {
    const { data } = await drive().files.list({
      q,
      fields: `files(${FILE_FIELDS})`,
      orderBy: 'modifiedTime desc',
      pageSize: 25,
    });
    const files = await Promise.all(data.files.map(shapeFile));
    // Rank by how many query words appear in the name.
    const score = (f) => words.filter((w) => f.name.toLowerCase().includes(w.toLowerCase())).length;
    return files.sort((a, b) => score(b) - score(a));
  });
}

const STOP = new Set(['the', 'and', 'for', 'file', 'files', 'document', 'doc', 'docs', 'my', 'find', 'report']);
