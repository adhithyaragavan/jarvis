/* ============================================================
   JARVIS command centre — client
   Pipeline per command: plan → for each step: prepare → (confirm | upload UI) → execute
   Commands run one at a time through a queue; "Interrupt" mode cancels the
   running command and jumps the new one to the front.
   ============================================================ */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => Math.random().toString(36).slice(2, 9);

class ApiError extends Error {
  constructor(code, message, hint) { super(message); this.code = code; this.hint = hint; }
}
class Cancelled extends Error {
  constructor(reason = 'cancelled') { super(reason); this.reason = reason; }
}

async function api(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (signal?.aborted || err.name === 'AbortError') throw new Cancelled(signal?.reason || 'cancelled');
    setCore('offline');
    throw new ApiError('OFFLINE', 'I have lost contact with the JARVIS server. Is it running?');
  }
  setCore(state.running ? 'busy' : 'online');
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error?.code || 'HTTP_' + res.status, json.error?.message || res.statusText, json.error?.hint);
  return json;
}

/* ---------------- formatting ---------------- */
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (d) => new Date(d).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDay = (d) => new Date(d).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
function relDay(d) {
  const a = new Date(d); a.setHours(0, 0, 0, 0);
  const b = new Date(); b.setHours(0, 0, 0, 0);
  const diff = Math.round((a - b) / 864e5);
  return diff === 0 ? 'TODAY' : diff === 1 ? 'TOMORROW' : diff === -1 ? 'YESTERDAY' : diff > 0 ? `IN ${diff} DAYS` : `${-diff} DAYS AGO`;
}
function relTime(d) {
  const ms = new Date(d) - Date.now();
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60e3), h = Math.floor(m / 60), dd = Math.floor(h / 24);
  const s = dd >= 1 ? `${dd}d ${h % 24}h` : h >= 1 ? `${h}h ${m % 60}m` : `${m}m`;
  return ms >= 0 ? `in ${s}` : `overdue ${s}`;
}
const ago = (d) => {
  const s = Math.round((Date.now() - new Date(d)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return fmtDateTime(d);
};

/* ---------------- state ---------------- */
const state = {
  history: [],
  pending: null,
  queue: [],
  running: null,
  status: null,
  tab: 'calendar',
  drive: { folderId: 'root', results: null, search: '' },
  highlight: {},
  voice: localGet('jarvis.voice') === '1',
};
function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

/* ---------------- header: clock + status ---------------- */
setInterval(() => ($('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false })), 1000);

function setCore(mode) {
  const el = $('#coreStatus');
  el.dataset.state = mode;
  $('.label', el).textContent = mode === 'offline' ? 'OFFLINE' : 'ONLINE';
  document.body.classList.toggle('busy', mode === 'busy');
}

async function loadStatus() {
  try {
    state.status = await api('/api/status');
  } catch {
    return;
  }
  const { google, telegram, ai } = state.status;
  const set = (id, st, title) => { const c = $(id); c.dataset.state = st; c.title = title; };
  set('#chipAi', ai.state, ai.state === 'connected' ? `AI core: ${ai.provider} (${ai.model})` : `AI core: ${ai.reason}`);
  set('#chipGoogle', google.state, {
    connected: `Google connected${google.email ? ' — ' + google.email : ''}`,
    disconnected: 'Google not connected — click to authorise',
    expired: 'Google authorisation expired — click to reconnect',
    unconfigured: 'Google not configured on the server (.env)',
  }[google.state]);
  set('#chipTelegram', telegram.state, telegram.state === 'connected' ? `Telegram bot @${telegram.bot}` : telegram.error || 'Telegram not configured (.env)');
  refreshTab(state.tab);
}

$('#chipGoogle').addEventListener('click', async () => {
  const st = state.status?.google?.state;
  if (st === 'disconnected' || st === 'expired') return (location.href = '/auth/google');
  if (st === 'unconfigured') return alertBox('err', 'GOOGLE OFFLINE', 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env and restart JARVIS.');
  alertBox('info', 'GOOGLE LINK ACTIVE', `Connected${state.status.google.email ? ' as ' + esc(state.status.google.email) : ''}.`, [
    { label: 'Disconnect', cls: 'danger', fn: async () => { await api('/api/google/disconnect', { method: 'POST' }); loadStatus(); } },
  ]);
});
$('#chipTelegram').addEventListener('click', () => activateTab('comms'));
$('#chipAi').addEventListener('click', () => {
  const ai = state.status?.ai;
  if (!ai) return;
  alertBox('info', 'AI CORE', ai.state === 'connected'
    ? `Natural-language planning by ${esc(ai.provider)} (<span class="mono">${esc(ai.model)}</span>).`
    : `${esc(ai.reason)} Add GEMINI_API_KEY (or ANTHROPIC_API_KEY) to .env for full natural-language understanding.`);
});

/* ---------------- alerts ---------------- */
function alertBox(kind, title, html, actions = [], ttl = kind === 'warn' ? 0 : 6000) {
  const el = document.createElement('div');
  el.className = `alert ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b><div>${html}</div>`;
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'alert-actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = `btn sm ${a.cls || ''}`;
      b.textContent = a.label;
      b.onclick = () => { a.fn?.(); el.remove(); };
      row.append(b);
    }
    const close = document.createElement('button');
    close.className = 'btn sm ghost'; close.textContent = 'Dismiss'; close.onclick = () => el.remove();
    row.append(close);
    el.append(row);
  }
  $('#alerts').prepend(el);
  if (ttl) setTimeout(() => el.remove(), ttl);
  return el;
}

/* ---------------- voice ---------------- */
const voiceBtn = $('#voiceToggle');
voiceBtn.setAttribute('aria-pressed', String(state.voice));
voiceBtn.onclick = () => {
  state.voice = !state.voice;
  localSet('jarvis.voice', state.voice ? '1' : '0');
  voiceBtn.setAttribute('aria-pressed', String(state.voice));
  if (state.voice) speak('Voice output online, sir.');
  else speechSynthesis?.cancel();
};
function speak(text) {
  if (!state.voice || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text.replace(/[•“”"]/g, '').slice(0, 300));
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find((v) => /en-GB/i.test(v.lang) && /male|daniel|arthur|george/i.test(v.name)) || voices.find((v) => /en-GB/i.test(v.lang)) || null;
  u.rate = 1.04; u.pitch = 0.9;
  speechSynthesis.speak(u);
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $('#micBtn');
if (!SR) micBtn.hidden = true;
else {
  const rec = new SR();
  rec.lang = 'en-US'; rec.interimResults = true;
  let listening = false;
  rec.onresult = (e) => {
    const t = [...e.results].map((r) => r[0].transcript).join('');
    input.value = t; autosize();
    if (e.results[e.results.length - 1].isFinal) { rec.stop(); submit(t); }
  };
  rec.onend = () => { listening = false; micBtn.classList.remove('listening'); };
  rec.onerror = (e) => alertBox('err', 'VOICE INPUT', esc(e.error));
  micBtn.onclick = () => {
    if (listening) return rec.stop();
    listening = true; micBtn.classList.add('listening'); rec.start();
  };
}

/* ---------------- console log ---------------- */
const log = $('#log');
const input = $('#input');

function addMsg(who, html, cls = '') {
  $('#welcome')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${who} ${cls}`;
  el.innerHTML = `<span class="who">${who === 'user' ? 'TONY' : 'JARVIS'} · ${fmtTime(new Date())}</span><div class="bubble">${html}</div>`;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}
const scrollLog = () => (log.scrollTop = log.scrollHeight);

$('#clearChat').onclick = () => {
  log.innerHTML = '';
  state.history = [];
  state.pending = null;
  $('#pendingHint').hidden = true;
  addMsg('jarvis', 'Console cleared. Standing by, sir.');
};

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(input.value); }
});
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); submit(input.value); });
$('#suggestions')?.addEventListener('click', (e) => { if (e.target.matches('button')) submit(e.target.textContent); });

/* ---------------- queue engine ---------------- */
const mode = () => $('input[name=mode]:checked').value;

function submit(text) {
  text = text.trim();
  if (!text) return;
  input.value = ''; autosize();
  const cmd = { id: uid(), text, abort: new AbortController(), status: 'queued' };
  addMsg('user', esc(text));

  if (state.running && mode() === 'interrupt') {
    const victim = state.running;
    victim.abort.abort('interrupted');
    state.queue.unshift(cmd);
    addMsg('jarvis', `Interrupting “${esc(victim.text.slice(0, 60))}” — switching to your new instruction.`, 'clarify');
  } else {
    state.queue.push(cmd);
    if (state.running) {
      addMsg('jarvis', `Queued behind the current operation (position ${state.queue.length}).`).querySelector('.who').textContent += ' · QUEUE';
    }
  }
  renderQueue();
  pump();
}

async function pump() {
  if (state.running || !state.queue.length) return;
  const cmd = state.queue.shift();
  state.running = cmd;
  cmd.status = 'running';
  setCore('busy');
  renderQueue();
  try {
    await runCommand(cmd);
  } catch (err) {
    if (!(err instanceof Cancelled)) console.error(err);
  } finally {
    state.running = null;
    setCore('online');
    renderQueue();
    pump();
  }
}

function renderQueue() {
  const items = [...(state.running ? [state.running] : []), ...state.queue];
  $('#queue').hidden = items.length === 0;
  $('#queueCount').textContent = `${state.queue.length} WAITING`;
  $('#queueList').innerHTML = '';
  items.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = c === state.running ? 'running' : '';
    li.innerHTML = `<span class="q-state">${c === state.running ? 'RUNNING' : '#' + i}</span><span class="q-text">${esc(c.text)}</span>`;
    const b = document.createElement('button');
    b.textContent = c === state.running ? 'ABORT' : 'DROP';
    b.onclick = () => cancelCommand(c);
    li.append(b);
    $('#queueList').append(li);
  });
}

function cancelCommand(cmd) {
  if (cmd === state.running) {
    cmd.abort.abort('cancelled');
  } else {
    state.queue = state.queue.filter((c) => c !== cmd);
    addMsg('jarvis', `Dropped queued command: “${esc(cmd.text.slice(0, 80))}”.`);
    renderQueue();
  }
}

// Reject when the command is aborted (interrupt / abort button).
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled(signal.reason));
    const onAbort = () => reject(new Cancelled(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/* ---------------- command execution ---------------- */
const STEP_LABEL = {
  create_event: ['Calendar', 'Create event'],
  list_events: ['Calendar', 'Read schedule'],
  cancel_event: ['Calendar', 'Cancel event'],
  create_reminder: ['Reminders', 'Create reminder'],
  list_reminders: ['Reminders', 'List reminders'],
  complete_reminder: ['Reminders', 'Complete reminder'],
  delete_reminder: ['Reminders', 'Delete reminder'],
  upload_file: ['Drive', 'Upload document'],
  search_drive: ['Drive', 'Search archive'],
  open_drive: ['Drive', 'Browse'],
  send_message: ['Telegram', 'Send message'],
  list_messages: ['Telegram', 'Communication history'],
};
function describe(s) {
  switch (s.action) {
    case 'create_event': return `${s.title} · ${s.start ? fmtDateTime(s.start) : 'time TBD'}${s.description ? ' · ' + s.description : ''}`;
    case 'list_events': return s.from ? `${fmtDay(s.from)}${s.to && new Date(s.to) - new Date(s.from) > 864e5 + 1 ? ' → ' + fmtDay(new Date(new Date(s.to) - 1)) : ''}` : 'Next 7 days';
    case 'cancel_event': return s.query || 'matching event';
    case 'create_reminder': return `${s.text} · ${s.due ? fmtDateTime(s.due) : 'time TBD'}`;
    case 'complete_reminder': case 'delete_reminder': return s.query;
    case 'upload_file': return s.folder_name ? `→ ${s.create_folder ? 'new folder ' : ''}${s.folder_name}` : 'Choose file & destination';
    case 'search_drive': return `“${s.query}”`;
    case 'open_drive': return s.folder_name || 'My Drive';
    case 'send_message': return `To ${s.recipient}: “${s.message}”`;
    default: return '';
  }
}

async function runCommand(cmd) {
  const signal = cmd.abort.signal;
  const bubbleMsg = addMsg('jarvis', `<span class="thinking"><b></b><b></b><b></b>&nbsp;ANALYSING REQUEST</span>`);
  const bubble = $('.bubble', bubbleMsg);

  let plan;
  try {
    plan = await api('/api/plan', { method: 'POST', body: { text: cmd.text, history: state.history.slice(-12), pending: state.pending }, signal });
  } catch (err) {
    if (err instanceof Cancelled) {
      bubble.innerHTML = `<span class="mono small">COMMAND ${err.reason === 'interrupted' ? 'INTERRUPTED' : 'ABORTED'} BEFORE EXECUTION</span>`;
      throw err;
    }
    bubbleMsg.classList.add('error');
    bubble.innerHTML = esc(err.message);
    return;
  }

  state.history.push({ role: 'user', content: cmd.text });
  bubble.innerHTML = `<div>${esc(plan.reply)}</div>`;
  if (plan.engine === 'rules' && plan.notice) bubble.insertAdjacentHTML('beforeend', `<div class="meta engine">${esc(plan.notice)}</div>`);

  if (plan.needs_clarification) {
    bubbleMsg.classList.add('clarify');
    if (plan.clarification_question && plan.clarification_question !== plan.reply) {
      bubble.insertAdjacentHTML('beforeend', `<div style="margin-top:6px">${esc(plan.clarification_question)}</div>`);
    }
    state.pending = state.pending ? `${state.pending} ${cmd.text}` : cmd.text;
    $('#pendingHint').hidden = false;
    state.history.push({ role: 'assistant', content: plan.clarification_question || plan.reply });
    speak(plan.clarification_question || plan.reply);
    return;
  }
  state.pending = null;
  $('#pendingHint').hidden = true;
  speak(plan.reply);

  if (!plan.steps?.length) {
    state.history.push({ role: 'assistant', content: plan.reply });
    return;
  }

  // ---- step tracker ----
  const list = document.createElement('ol');
  list.className = 'steps';
  const rows = plan.steps.map((s, i) => {
    const li = document.createElement('li');
    li.className = 'step';
    li.dataset.status = 'pending';
    const [area, verb] = STEP_LABEL[s.action] || ['JARVIS', s.action];
    li.innerHTML = `<span class="ico">${i + 1}</span><div><div class="lbl">${esc(area.toUpperCase())} · ${esc(verb.toUpperCase())}</div><div class="res">${esc(describe(s))}</div></div>`;
    list.append(li);
    return li;
  });
  bubble.append(list);
  scrollLog();

  const setRow = (li, status, text, extra) => {
    li.dataset.status = status;
    $('.ico', li).textContent = { running: '◠', waiting: '…', done: '✓', failed: '!', skipped: '–' }[status] || $('.ico', li).textContent;
    if (text !== undefined) $('.res', li).textContent = text;
    $('.act', li)?.remove();
    if (extra) $('div', li).append(extra);
    scrollLog();
  };

  const outcomes = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const li = rows[i];
    if (signal.aborted) {
      setRow(li, 'skipped', `${describe(step)} — ${signal.reason === 'interrupted' ? 'interrupted' : 'aborted'}`);
      logClientAction(step.action, signal.reason === 'interrupted' ? 'interrupted' : 'cancelled', `Skipped: ${describe(step)}`, cmd.id);
      outcomes.push('skipped');
      continue;
    }
    setRow(li, 'running');
    try {
      const prep = await api('/api/prepare', { method: 'POST', body: { step }, signal });
      let resolved = prep.step;
      let result;

      if (prep.confirm) {
        setRow(li, 'waiting', `Awaiting authorisation — ${prep.confirm.detail}`);
        const answer = await abortable(confirmDialog(prep.confirm, resolved), signal);
        if (!answer.ok) {
          setRow(li, 'skipped', `Declined by you — ${describe(resolved)}`);
          logClientAction(step.action, 'declined', `Declined: ${describe(resolved)}`, cmd.id);
          outcomes.push('skipped');
          continue;
        }
        if (answer.edited != null) resolved = { ...resolved, [prep.confirm.editable]: answer.edited };
        setRow(li, 'running');
      }

      if (prep.ui === 'upload') {
        setRow(li, 'waiting', 'Uplink console open — choose a document and destination.');
        result = await abortable(openUpload(resolved, cmd.id), signal);
        if (!result) {
          setRow(li, 'skipped', 'Upload cancelled.');
          logClientAction('upload_file', 'cancelled', 'Upload cancelled by you.', cmd.id);
          outcomes.push('skipped');
          continue;
        }
      } else {
        result = await api('/api/execute', { method: 'POST', body: { step: resolved, commandId: cmd.id }, signal });
      }

      setRow(li, 'done', result.summary);
      outcomes.push('done');
      applyPreview(result.preview);
    } catch (err) {
      if (err instanceof Cancelled) {
        closeDialogs();
        setRow(li, 'skipped', `${describe(step)} — ${err.reason === 'interrupted' ? 'interrupted' : 'aborted'}`);
        logClientAction(step.action, err.reason === 'interrupted' ? 'interrupted' : 'cancelled', `Aborted: ${describe(step)}`, cmd.id);
        outcomes.push('skipped');
        continue;
      }
      setRow(li, 'failed', err.message, errorActions(err, step));
      outcomes.push('failed');
    }
  }

  const done = outcomes.filter((o) => o === 'done').length;
  const failed = outcomes.filter((o) => o === 'failed').length;
  const total = outcomes.length;
  const line = document.createElement('div');
  if (signal.aborted) {
    line.className = 'result-line partial';
    line.textContent = `■ ${signal.reason === 'interrupted' ? 'INTERRUPTED' : 'ABORTED'} · ${done}/${total} COMPLETED`;
  } else if (done === total) {
    line.className = 'result-line ok';
    line.textContent = total > 1 ? `■ ALL ${total} OPERATIONS COMPLETE` : '■ OPERATION COMPLETE';
  } else {
    line.className = failed ? 'result-line bad' : 'result-line partial';
    line.textContent = `■ ${done}/${total} COMPLETED${failed ? ` · ${failed} FAILED` : ''}`;
  }
  bubble.append(line);
  scrollLog();

  const summaryText = rows.map((r) => $('.res', r).textContent).join(' ');
  state.history.push({ role: 'assistant', content: `${plan.reply}\nResults: ${summaryText}` });
  if (total > 1 || failed) speak(done === total ? 'All tasks complete, sir.' : `${done} of ${total} tasks completed.`);
  else if (done === 1) speak($('.res', rows[0]).textContent.split('\n')[0]);
}

function errorActions(err, step) {
  const wrap = document.createElement('div');
  wrap.className = 'act';
  const add = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `btn sm ${cls}`; b.textContent = label; b.onclick = fn;
    wrap.append(b);
  };
  if (err.code === 'AUTH_EXPIRED' && /google/i.test(err.message)) add('Reconnect Google', () => (location.href = '/auth/google'), 'primary');
  if (err.code === 'INTEGRATION_UNAVAILABLE') add('Setup help', () => alertBox('info', 'INTEGRATION OFFLINE', 'Fill in the matching keys in <span class="mono">.env</span> (see README) and restart JARVIS.'));
  if (step.action === 'send_message' && err.code === 'NOT_FOUND') add('Manage contacts', () => activateTab('comms'));
  if (!['MISSING_FIELD'].includes(err.code)) add('Retry', () => submit(retryText(step)));
  return wrap.children.length ? wrap : null;
}
function retryText(step) {
  switch (step.action) {
    case 'send_message': return `Send ${step.recipient} a message saying ${step.message}`;
    case 'create_event': return `Schedule ${step.title} at ${fmtDateTime(step.start)}${step.description ? ' about ' + step.description : ''}`;
    case 'create_reminder': return `Remind me to ${step.text} at ${fmtDateTime(step.due)}`;
    case 'search_drive': return `Find ${step.query}`;
    case 'upload_file': return 'Upload a document to my Drive';
    default: return `${STEP_LABEL[step.action]?.[1] || step.action} ${describe(step)}`;
  }
}

function logClientAction(action, status, summary, commandId) {
  api('/api/actions/log', { method: 'POST', body: { action, status, summary, commandId } }).catch(() => {});
}

/* ---------------- confirm dialog ---------------- */
const confirmDlg = $('#confirmDialog');
function confirmDialog(c) {
  return new Promise((resolve) => {
    confirmDlg.classList.toggle('danger', Boolean(c.danger));
    $('#confirmTitle').textContent = c.title;
    $('#confirmDetail').textContent = c.detail;
    $('#confirmOk').textContent = c.danger ? 'Confirm' : 'Authorise';
    $('#confirmOk').className = `btn ${c.danger ? 'danger' : 'primary'}`;
    const edit = $('#confirmEdit');
    $('#confirmEditWrap').hidden = !c.editable;
    if (c.editable) {
      const m = c.detail.match(/“([\s\S]*)”$/);
      edit.value = m ? m[1] : '';
    }
    confirmDlg.returnValue = '';
    confirmDlg.onclose = () => {
      const ok = confirmDlg.returnValue === 'ok';
      resolve({ ok, edited: ok && c.editable ? edit.value.trim() : null });
    };
    confirmDlg.showModal();
    (c.editable ? $('#confirmOk') : $('#confirmOk')).focus();
  });
}
function closeDialogs() {
  if (confirmDlg.open) confirmDlg.close('cancel');
  if (uploadDlg.open) { uploadXhr?.abort(); uploadDlg.close('cancel'); }
}

/* ---------------- upload dialog ---------------- */
const uploadDlg = $('#uploadDialog');
const fileInput = $('#fileInput');
const drop = $('#dropZone');
let uploadFile = null;
let uploadXhr = null;
let uploadResolve = null;
let uploadCommandId = null;

function setUploadFile(f) {
  uploadFile = f;
  drop.classList.toggle('has-file', Boolean(f));
  $('#dropText').innerHTML = f ? `<b>${esc(f.name)}</b> · ${(f.size / 1024 / 1024).toFixed(2)} MB — click to change` : 'Drop a document here or <u>browse your device</u>';
}
drop.addEventListener('click', (e) => { if (e.target !== fileInput) { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => setUploadFile(fileInput.files[0] || null));
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => setUploadFile(e.dataTransfer.files[0] || null));
$$('input[name=dest]').forEach((r) => r.addEventListener('change', () => ($('.dest').dataset.mode = r.value)));

async function openUpload(step = {}, commandId = null) {
  setUploadFile(null);
  fileInput.value = '';
  uploadCommandId = commandId;
  setProgress(null);
  $('#uploadGo').disabled = false;
  $('#uploadGo').textContent = 'Upload to Drive';
  $('#newFolderName').value = '';
  const destMode = step.create_folder ? 'new' : 'existing';
  $(`input[name=dest][value=${destMode}]`).checked = true;
  $('.dest').dataset.mode = destMode;

  let folders = [];
  try { folders = await api('/api/drive/folders'); } catch (err) { alertBox('err', 'DRIVE', esc(err.message)); }
  const opts = '<option value="root">My Drive</option>' + folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  $('#folderSelect').innerHTML = opts;
  $('#newFolderParent').innerHTML = opts;
  const preferred = state.tab === 'drive' && state.drive.folderId !== 'root' ? state.drive.folderId : 'root';
  $('#folderSelect').value = preferred;
  if (step.folder_name) {
    const hit = folders.find((f) => f.name.toLowerCase() === step.folder_name.toLowerCase());
    if (hit && !step.create_folder) $('#folderSelect').value = hit.id;
    else if (!hit) {
      $('input[name=dest][value=new]').checked = true;
      $('.dest').dataset.mode = 'new';
      $('#newFolderName').value = step.folder_name;
    } else $('#newFolderName').value = step.folder_name;
  }
  uploadDlg.showModal();
  return new Promise((resolve) => (uploadResolve = resolve));
}

function setProgress(kind, pct, text) {
  const p = $('#uploadProgress');
  if (!kind) { p.hidden = true; p.className = 'progress'; return; }
  p.hidden = false;
  p.className = `progress ${kind}`;
  $('#uploadBar').style.width = `${pct || 0}%`;
  $('#uploadStatus').textContent = text;
}

uploadDlg.addEventListener('close', () => {
  uploadXhr?.abort();
  const r = uploadResolve; uploadResolve = null;
  r?.(uploadDlg.returnValue === 'done' ? uploadDlg._result : null);
});

$('#uploadGo').addEventListener('click', () => {
  if (!uploadFile) return setProgress('bad', 100, 'Select a document first, sir.');
  const destNew = $('input[name=dest]:checked').value === 'new';
  const newName = $('#newFolderName').value.trim();
  if (destNew && !newName) return setProgress('bad', 100, 'The new folder needs a name.');

  const fd = new FormData();
  fd.append('file', uploadFile);
  if (destNew) {
    fd.append('folderId', $('#newFolderParent').value);
    fd.append('newFolderName', newName);
  } else {
    fd.append('folderId', $('#folderSelect').value);
    fd.append('folderName', $('#folderSelect').selectedOptions[0].textContent);
  }
  if (uploadCommandId) fd.append('commandId', uploadCommandId);

  $('#uploadGo').disabled = true;
  setProgress('', 0, 'Transmitting to JARVIS… 0%');
  const xhr = (uploadXhr = new XMLHttpRequest());
  xhr.open('POST', '/api/drive/upload');
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    if (pct < 100) setProgress('', pct, `Transmitting to JARVIS… ${pct}%`);
    else setProgress('indeterminate', 100, 'Relaying to Google Drive…');
  };
  xhr.onload = () => {
    uploadXhr = null;
    let json = {};
    try { json = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 200 && xhr.status < 300) {
      setProgress('ok', 100, `✓ ${json.summary}`);
      uploadDlg._result = json;
      setTimeout(() => uploadDlg.close('done'), 900);
    } else {
      const msg = json.error?.message || `Upload failed (HTTP ${xhr.status}).`;
      setProgress('bad', 100, `✕ ${msg}`);
      $('#uploadGo').disabled = false;
      $('#uploadGo').textContent = 'Retry upload';
      if (json.error?.code === 'AUTH_EXPIRED') loadStatus();
    }
  };
  xhr.onerror = () => {
    uploadXhr = null;
    setProgress('bad', 100, '✕ Connection lost during upload.');
    $('#uploadGo').disabled = false;
    $('#uploadGo').textContent = 'Retry upload';
  };
  xhr.send(fd);
});

/* ---------------- preview tabs ---------------- */
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) activateTab(b.dataset.tab);
});
function activateTab(tab, flash = false) {
  state.tab = tab;
  $$('#tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
    if (flash && b.dataset.tab === tab) { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }
  });
  $$('.tab-body').forEach((p) => p.toggleAttribute('data-active', p.id === `tab-${tab}`));
  refreshTab(tab);
}

function applyPreview(p) {
  if (!p?.tab) return;
  if (p.highlight) state.highlight[p.tab] = p.highlight;
  if (p.tab === 'drive') {
    if (p.results) { state.drive.results = p.results; state.drive.search = p.search; }
    else { state.drive.results = null; if (p.folderId) state.drive.folderId = p.folderId; }
  }
  activateTab(p.tab, true);
  if ($('#layout').dataset.view === 'console') $('#mobileBadge').hidden = false;
}

const loaders = {};
let refreshSeq = 0;
async function refreshTab(tab) {
  if (tab !== state.tab) return;
  const seq = ++refreshSeq;
  const sync = $('#syncState');
  sync.textContent = 'SYNCING'; sync.classList.add('busy');
  try {
    await loaders[tab]?.($(`#tab-${tab}`));
  } finally {
    if (seq === refreshSeq) { sync.textContent = `SYNCED ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; sync.classList.remove('busy'); }
  }
}

function googleGate(el, what) {
  const g = state.status?.google;
  if (!g || g.state === 'connected') return false;
  const msg = {
    unconfigured: `Google ${what} is offline. Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to <code>.env</code> and restart.`,
    disconnected: `Authorise JARVIS to access your Google ${what}.`,
    expired: 'Your Google authorisation has expired. Reconnect to resume live sync.',
  }[g.state];
  el.innerHTML = `<div class="offline-card"><b>${g.state === 'expired' ? 'AUTHORISATION EXPIRED' : 'INTEGRATION OFFLINE'}</b><p>${msg}</p>${g.state !== 'unconfigured' ? '<a class="btn primary" href="/auth/google">Connect Google</a>' : ''}</div>`;
  return true;
}
function errorCard(el, err) {
  el.innerHTML = `<div class="offline-card"><b>${esc(err.code || 'ERROR')}</b><p>${esc(err.message)}</p>${err.code === 'AUTH_EXPIRED' ? '<a class="btn primary" href="/auth/google">Reconnect Google</a>' : ''}</div>`;
  if (err.code === 'AUTH_EXPIRED') loadStatus();
}

/* --- calendar --- */
loaders.calendar = async (el) => {
  if (googleGate(el, 'Calendar')) return;
  let events, reminders;
  try {
    [events, reminders] = await Promise.all([api('/api/calendar'), api('/api/reminders')]);
  } catch (err) { return errorCard(el, err); }
  const items = [
    ...events.map((e) => ({ ...e, kind: 'event', at: e.start })),
    ...reminders.filter((r) => !r.done && new Date(r.due) >= new Date(new Date().setHours(0, 0, 0, 0))).map((r) => ({ ...r, kind: 'reminder', at: r.due })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const hl = state.highlight.calendar;
  const head = `<div class="pane-head"><h4>Upcoming · 14 days</h4><span class="spacer"></span><span class="kind ev">EVENT</span><span class="kind rm">REMINDER</span>
    <a class="btn sm ghost" href="https://calendar.google.com" target="_blank" rel="noopener">Open Google Calendar ↗</a></div>`;
  if (!items.length) {
    el.innerHTML = head + `<div class="empty"><b>NO UPCOMING EVENTS</b>Your schedule is clear, sir.<br/><button class="btn" data-say="Schedule a meeting with Bruce Banner tomorrow at 4 PM">Try: schedule a meeting</button></div>`;
  } else {
    const days = new Map();
    for (const it of items) {
      const k = new Date(it.at).toDateString();
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(it);
    }
    el.innerHTML = head + [...days].map(([k, list]) => `
      <div class="day"><div class="day-label"><span>${esc(fmtDay(k).toUpperCase())}</span><span class="rel">${relDay(k)}</span></div>
      ${list.map((it) => it.kind === 'event' ? `
        <div class="event ${it.id === hl ? 'hl' : ''}">
          <div class="t">${it.allDay ? 'ALL DAY' : fmtTime(it.start)}${!it.allDay && it.end ? `<small>→ ${fmtTime(it.end)}</small>` : ''}</div>
          <div><div class="title">${esc(it.title)}</div>${it.description ? `<div class="descr">${esc(it.description)}</div>` : ''}${it.location ? `<div class="descr">⌖ ${esc(it.location)}</div>` : ''}</div>
          <div><span class="kind ev">EVENT</span><br/>${it.link ? `<a href="${esc(it.link)}" target="_blank" rel="noopener">open ↗</a>` : ''}</div>
        </div>` : `
        <div class="event reminder-ghost">
          <div class="t">${fmtTime(it.due)}</div>
          <div><div class="title">${esc(it.text)}</div><div class="descr">Personal reminder · stored by JARVIS</div></div>
          <div><span class="kind rm">REMINDER</span></div>
        </div>`).join('')}
      </div>`).join('');
  }
  delete state.highlight.calendar;
};

/* --- reminders --- */
loaders.reminders = async (el) => {
  let list;
  try { list = await api('/api/reminders'); } catch (err) { return errorCard(el, err); }
  const active = list.filter((r) => !r.done);
  const done = list.filter((r) => r.done);
  $('#remCount').textContent = active.length || '';
  const hl = state.highlight.reminders;
  const row = (r) => `
    <div class="rem ${r.done ? 'done' : new Date(r.due) < Date.now() ? 'overdue' : ''} ${r.id === hl ? 'hl' : ''}" data-id="${esc(r.id)}">
      <div><div class="rt">${esc(r.text)}</div><div class="rd">${fmtDateTime(r.due)} · ${r.done ? 'completed' : relTime(r.due)}</div></div>
      <div class="ra">${r.done ? '' : `<button class="btn sm doom" data-act="done" title="Mark done">✓</button><button class="btn sm" data-act="snooze" title="Snooze 10 minutes">+10m</button>`}<button class="btn sm danger" data-act="del" title="Delete">✕</button></div>
    </div>`;
  el.innerHTML = `<div class="pane-head"><h4>Personal Reminders</h4><span class="spacer"></span><span class="kind rm">${active.length} ACTIVE</span>
      <div class="desc">Reminders live in JARVIS (not Google Calendar). When one comes due you'll get an alert${state.status?.ownerNotifications ? ' and a Telegram ping' : ''}.</div></div>
    ${active.length ? active.map(row).join('') : `<div class="empty"><b>NO ACTIVE REMINDERS</b>Nothing to forget, sir.<br/><button class="btn" data-say="Remind me to check the reactor at 8 PM">Try: set a reminder</button></div>`}
    ${done.length ? `<details class="done-list"><summary>COMPLETED (${done.length})</summary>${done.slice(0, 30).map(row).join('')}</details>` : ''}`;
  delete state.highlight.reminders;
};
$('#tab-reminders').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.closest('.rem').dataset.id;
  const text = $('.rt', b.closest('.rem')).textContent;
  try {
    if (b.dataset.act === 'done') await api(`/api/reminders/${id}/done`, { method: 'POST' });
    if (b.dataset.act === 'snooze') await api(`/api/reminders/${id}/snooze`, { method: 'POST', body: { minutes: 10 } });
    if (b.dataset.act === 'del') {
      const ans = await confirmDialog({ title: 'Delete reminder?', detail: text, danger: true });
      if (ans.ok) await api(`/api/reminders/${id}`, { method: 'DELETE' });
    }
  } catch (err) { alertBox('err', 'REMINDERS', esc(err.message)); }
});

/* --- drive --- */
function fileIcon(f) {
  if (f.isFolder) return '<span class="ficon folder"></span>';
  const t = f.type.toLowerCase();
  const cls = t.includes('pdf') ? 'pdf' : /doc|word|text|markdown/.test(t) ? 'doc' : /sheet|excel/.test(t) ? 'sheet' : /slide|powerpoint/.test(t) ? 'slide' : /image/.test(t) ? 'img' : '';
  return `<span class="ficon ${cls}">${esc(t.slice(0, 3).toUpperCase())}</span>`;
}
function fileTable(files, { showLoc }) {
  const hl = state.highlight.drive;
  return `<table class="files"><thead><tr><th>Name</th><th>Type</th>${showLoc ? '<th class="col-loc">Location</th>' : ''}<th class="col-mod">Modified</th><th></th></tr></thead><tbody>
    ${files.map((f) => `<tr class="${f.id === hl ? 'hl' : ''}">
      <td><div class="fname">${fileIcon(f)}${f.isFolder ? `<button data-folder="${esc(f.id)}">${esc(f.name)}</button>` : esc(f.name)}</div></td>
      <td><span class="ftype">${esc(f.type)}</span></td>
      ${showLoc ? `<td class="loc col-loc">${f.folderId ? `<button class="btn sm ghost" data-folder="${esc(f.folderId)}">📁 ${esc(f.folder)}</button>` : esc(f.folder)}</td>` : ''}
      <td class="mod col-mod">${f.modifiedTime ? esc(ago(f.modifiedTime)) : '—'}</td>
      <td>${f.link ? `<a class="open" href="${esc(f.link)}" target="_blank" rel="noopener">OPEN ↗</a>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
}
loaders.drive = async (el) => {
  if (googleGate(el, 'Drive')) return;
  const head = `<div class="pane-head"><h4>Stark Archive · Google Drive</h4><span class="spacer"></span><button class="btn sm primary" data-upload>↑ Upload</button></div>
    <form class="search-row" data-search><input name="q" placeholder="Search the archive…" value="${esc(state.drive.search)}" /><button class="btn">Search</button></form>`;
  if (state.drive.results) {
    const r = state.drive.results;
    el.innerHTML = head + `<div class="results-banner"><span>${r.length} result${r.length === 1 ? '' : 's'} for <b>“${esc(state.drive.search)}”</b></span><button class="btn sm" data-clear>Back to folders</button></div>` +
      (r.length ? fileTable(r, { showLoc: true }) : `<div class="empty"><b>NO MATCHES</b>Try different keywords, sir.</div>`);
    delete state.highlight.drive;
    return;
  }
  let data;
  try { data = await api(`/api/drive/list?folderId=${encodeURIComponent(state.drive.folderId)}`); } catch (err) { return errorCard(el, err); }
  el.innerHTML = head +
    `<div class="crumbs">${data.crumbs.map((c, i) => `${i ? '<span>/</span>' : ''}<button data-folder="${esc(c.id)}">${esc(c.name)}</button>`).join('')}</div>` +
    (data.files.length ? fileTable(data.files, { showLoc: false }) : `<div class="empty"><b>FOLDER EMPTY</b>Upload a document to begin.</div>`);
  delete state.highlight.drive;
};
$('#tab-drive').addEventListener('click', async (e) => {
  const f = e.target.closest('[data-folder]');
  if (f) { state.drive.folderId = f.dataset.folder; state.drive.results = null; state.drive.search = ''; return refreshTab('drive'); }
  if (e.target.closest('[data-clear]')) { state.drive.results = null; state.drive.search = ''; return refreshTab('drive'); }
  if (e.target.closest('[data-upload]')) {
    const res = await openUpload({});
    if (res) { applyPreview(res.preview); addMsg('jarvis', esc(res.summary)); }
  }
});
$('#tab-drive').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = new FormData(e.target).get('q').trim();
  if (!q) return;
  try {
    state.drive.results = await api(`/api/drive/search?q=${encodeURIComponent(q)}`);
    state.drive.search = q;
    refreshTab('drive');
  } catch (err) { alertBox('err', 'DRIVE SEARCH', esc(err.message)); }
});

/* --- comms --- */
loaders.comms = async (el) => {
  let msgs, contacts;
  try { [msgs, contacts] = await Promise.all([api('/api/messages'), api('/api/contacts')]); } catch (err) { return errorCard(el, err); }
  const tgState = state.status?.telegram;
  const offline = tgState && tgState.state !== 'connected'
    ? `<div class="offline-card" style="margin-bottom:14px"><b>TELEGRAM OFFLINE</b><p>${tgState.state === 'unconfigured' ? 'Add <code>TELEGRAM_BOT_TOKEN</code> to <code>.env</code> and restart JARVIS.' : esc(tgState.error || 'Bot unreachable.')}</p></div>` : '';
  el.innerHTML = `${offline}
    <div class="pane-head"><h4>Contacts</h4><span class="spacer"></span>
      <button class="btn sm" data-sync ${tgState?.state !== 'connected' ? 'disabled' : ''} title="Import everyone who has messaged the bot">⟳ Sync from bot</button>
      <div class="desc">Recipients must press <b>Start</b> on ${tgState?.bot ? `<span class="mono">@${esc(tgState.bot)}</span>` : 'your bot'} once. Tag people as <b>team</b> for “message the team”.</div></div>
    <div class="contacts">${contacts.length ? contacts.map((c) => `<span class="contact" data-id="${esc(c.id)}">${esc(c.name)} <small>${esc(c.chatId)}</small>
      <button class="team ${c.team ? 'on' : ''}" data-team>TEAM</button><button class="x" data-del title="Remove">×</button></span>`).join('') : '<span class="small">No contacts yet.</span>'}</div>
    <form class="add-contact" data-add>
      <input class="field" name="name" placeholder="Name (e.g. Bruce Banner)" required />
      <input class="field" name="chatId" placeholder="Telegram chat ID" required />
      <label><input type="checkbox" name="team" /> team</label>
      <button class="btn">Add</button>
    </form>
    <div class="pane-head"><h4>Communication Log</h4><span class="spacer"></span><span class="by-jarvis">SENT BY JARVIS</span></div>
    <div class="msglog">${msgs.length ? msgs.map((m) => `
      <div class="mrow">
        <div class="to">→ ${esc(m.recipient)}<small>TELEGRAM</small></div>
        <span class="status-pill ${esc(m.status)}">${esc(m.status)}</span>
        <div class="txt">${esc(m.text)}</div>
        <div class="when">${fmtDateTime(m.sentAt || m.createdAt)} · ${esc(ago(m.sentAt || m.createdAt))}</div>
        <span class="by-jarvis" style="justify-self:end">VIA ${esc(m.via || 'JARVIS')}</span>
        ${m.error ? `<div class="err">${esc(m.error)}</div>` : ''}
      </div>`).join('') : `<div class="empty"><b>NO TRANSMISSIONS</b>Try: “Send Bruce a message saying the experiment is postponed.”</div>`}</div>`;
};
$('#tab-comms').addEventListener('click', async (e) => {
  const chip = e.target.closest('.contact');
  try {
    if (e.target.closest('[data-sync]')) {
      const found = await api('/api/contacts/sync', { method: 'POST' });
      alertBox('info', 'TELEGRAM SYNC', found.length ? `Imported ${found.length} contact(s): ${found.map((c) => esc(c.name)).join(', ')}` : 'Nobody new has messaged the bot yet. Ask them to press Start on the bot, then sync again.');
      refreshTab('comms');
    } else if (chip && e.target.closest('[data-team]')) {
      await api(`/api/contacts/${chip.dataset.id}`, { method: 'PATCH', body: { team: !e.target.classList.contains('on') } });
      refreshTab('comms');
    } else if (chip && e.target.closest('[data-del]')) {
      await api(`/api/contacts/${chip.dataset.id}`, { method: 'DELETE' });
      refreshTab('comms');
    }
  } catch (err) { alertBox('err', 'CONTACTS', esc(err.message)); }
});
$('#tab-comms').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/api/contacts', { method: 'POST', body: { name: fd.get('name'), chatId: fd.get('chatId'), team: fd.get('team') === 'on' } });
    refreshTab('comms');
  } catch (err) { alertBox('err', 'CONTACTS', esc(err.message)); }
});

/* --- activity --- */
loaders.activity = async (el) => {
  let acts;
  try { acts = await api('/api/actions'); } catch (err) { return errorCard(el, err); }
  el.innerHTML = `<div class="pane-head"><h4>Action History</h4><span class="spacer"></span><span class="by-jarvis">PERFORMED BY JARVIS</span>
    <div class="desc">Every operation JARVIS attempted — successful, failed, declined or interrupted.</div></div>` +
    (acts.length ? `<ul class="timeline">${acts.map((a) => `
      <li class="${esc(a.status)}"><div class="tl-top"><span class="tl-label">${esc((a.label || a.kind || '').toUpperCase())}</span><span class="status-pill ${esc(a.status)}">${esc(a.status)}</span><span class="tl-time">${esc(ago(a.createdAt))}</span></div>
      <div class="tl-sum">${esc(a.summary)}</div></li>`).join('')}</ul>` : `<div class="empty"><b>NO ACTIVITY YET</b>Issue a command to get started.</div>`);
};

// "Try: …" buttons inside empty states
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-say]');
  if (b) { submit(b.dataset.say); switchView('console'); }
});

/* ---------------- mobile view switch ---------------- */
function switchView(v) {
  $('#layout').dataset.view = v;
  $$('.mobile-switch button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'preview') { $('#mobileBadge').hidden = true; refreshTab(state.tab); }
}
$$('.mobile-switch button').forEach((b) => (b.onclick = () => switchView(b.dataset.view)));

/* ---------------- live updates ---------------- */
function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => setCore(state.running ? 'busy' : 'online');
  es.onerror = () => setCore('offline');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'refresh') {
      const map = { calendar: ['calendar'], reminders: ['reminders', 'calendar'], drive: ['drive'], comms: ['comms'], contacts: ['comms'], actions: ['activity'] };
      for (const t of map[ev.scope] || []) refreshTab(t);
      if (ev.scope === 'reminders') api('/api/reminders').then((l) => ($('#remCount').textContent = l.filter((r) => !r.done).length || '')).catch(() => {});
    } else if (ev.type === 'status') {
      loadStatus();
    } else if (ev.type === 'reminder_due') {
      const r = ev.reminder;
      alertBox('warn', '⏰ REMINDER', `<div style="font-size:17px;font-weight:600">${esc(r.text)}</div><div class="mono small">${fmtDateTime(r.due)}${ev.telegram ? ' · also sent to your Telegram' : ''}</div>`, [
        { label: 'Done', cls: 'doom', fn: () => api(`/api/reminders/${r.id}/done`, { method: 'POST' }) },
        { label: 'Snooze 10m', fn: () => api(`/api/reminders/${r.id}/snooze`, { method: 'POST', body: { minutes: 10 } }) },
      ]);
      speak(`Sir, a reminder: ${r.text}`);
      if ('Notification' in window && Notification.permission === 'granted') new Notification('JARVIS reminder', { body: r.text });
    }
  };
}

/* ---------------- boot ---------------- */
(async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('auth') === 'google') alertBox('info', 'GOOGLE LINKED', 'Calendar and Drive are now online, sir.');
  if (params.get('auth_error')) alertBox('err', 'GOOGLE AUTH FAILED', esc(params.get('auth_error')));
  if (params.toString()) history.replaceState(null, '', '/');
  if ('Notification' in window && Notification.permission === 'default') {
    document.addEventListener('click', () => Notification.requestPermission(), { once: true });
  }
  connectStream();
  await loadStatus();
  api('/api/reminders').then((l) => ($('#remCount').textContent = l.filter((r) => !r.done).length || '')).catch(() => {});
  setInterval(() => ['reminders', 'calendar'].includes(state.tab) && refreshTab(state.tab), 60_000);
  input.focus();
})();
