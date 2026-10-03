// Tiny JSON-file persistence for reminders, comms, action history and contacts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const empty = () => ({ reminders: [], messages: [], actions: [], contacts: [] });

let db = empty();
try {
  db = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }, 50);
}

export const id = () => crypto.randomUUID().slice(0, 8);

export const store = {
  get: (key) => db[key],
  insert(key, item) {
    const row = { id: id(), createdAt: new Date().toISOString(), ...item };
    db[key].unshift(row);
    if (key === 'actions' && db.actions.length > 300) db.actions.length = 300;
    save();
    return row;
  },
  update(key, rowId, patch) {
    const row = db[key].find((r) => r.id === rowId);
    if (!row) return null;
    Object.assign(row, patch);
    save();
    return row;
  },
  remove(key, rowId) {
    const i = db[key].findIndex((r) => r.id === rowId);
    if (i === -1) return null;
    const [row] = db[key].splice(i, 1);
    save();
    return row;
  },
  upsertContact(contact) {
    const existing = db.contacts.find(
      (c) => String(c.chatId) === String(contact.chatId) || c.name.toLowerCase() === contact.name.toLowerCase()
    );
    if (existing) Object.assign(existing, contact);
    else db.contacts.push({ id: id(), ...contact });
    save();
    return existing || db.contacts.at(-1);
  },
};
