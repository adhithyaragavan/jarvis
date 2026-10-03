# J.A.R.V.I.S. — Stark Command Centre

A web-based personal AI assistant for Tony Stark, built around a **JARVIS × Doomsday** HUD.
One console understands natural-language commands and runs them against **Google Calendar**, **Google Drive**, a **personal reminder system** and **Telegram**. A live preview pane next to the console shows each result as it lands.

```
┌──────────── COMMAND CONSOLE ────────────┐┌──────── LIVE INTEGRATION PREVIEW ────────┐
│ Tony: schedule the Stark team meeting   ││ [Calendar] Reminders  Drive  Comms  Log  │
│ tomorrow 6pm, remind me 30 min before,  ││                                          │
│ and message Bruce about it              ││  SUNDAY 4 OCTOBER            TOMORROW    │
│                                         ││  17:30  Stark team meeting   REMINDER    │
│ JARVIS: ✓ Calendar · Create event       ││  18:00  Stark team meeting   EVENT  ↗    │
│         ✓ Reminders · Create reminder   ││                                          │
│         ✓ Telegram · Send (authorised)  ││                                          │
│ ■ ALL 3 OPERATIONS COMPLETE             ││                                          │
│ [Queue|Interrupt]  > _____________ (→)  ││                                          │
└─────────────────────────────────────────┘└──────────────────────────────────────────┘
```

## Quick start

```bash
cd jarvis
npm install
cp .env.example .env      # fill in the keys you have (see below)
npm start                 # → http://localhost:3000
```

JARVIS runs without any keys. Each integration that isn't configured shows as offline in the header, and commands that need it fail with a clear explanation. Without an AI key, a built-in rule-based parser handles the commands.

## Configuration

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google Gemini plans commands (free key from aistudio.google.com). Auto-picks the newest Flash model; override with `GEMINI_MODEL`. |
| `ANTHROPIC_API_KEY` | Alternative AI core: Claude (`claude-opus-5-5`). If both keys are set, Gemini is used unless `JARVIS_LLM=claude`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client for Calendar + Drive. |
| `TELEGRAM_BOT_TOKEN` | Bot used to send messages. |
| `TELEGRAM_OWNER_CHAT_ID` | Optional: Tony's own chat ID. Due reminders are also pushed to Telegram. |
| `TIMEZONE` | IANA timezone for events (defaults to the machine's). |
| `CONFIRM_EVENTS=1` | Also ask for confirmation before creating calendar events. |

### Google (Calendar + Drive)
1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Calendar API** and the **Google Drive API**.
2. Under **OAuth consent screen**, choose External and add your Google account as a **test user**.
3. Under **Credentials → Create credentials → OAuth client ID**, choose *Web application*, with redirect URI `http://localhost:3000/auth/google/callback`.
4. Put the client ID and secret in `.env`, restart, then click **GOOGLE** in the header to authorise.
   Tokens are stored in `data/google-tokens.json` and refresh automatically. If access is revoked or expires, the chip turns red and every Google action offers **Reconnect Google**.

### Telegram
1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Telegram bots can only message people who have started a chat with the bot, so each recipient (Bruce, Pepper…) must open the bot once and press **Start**.
3. In **Live Preview → Comms**, click **Sync from bot** to import them automatically. You can also add a name and chat ID by hand. Tag contacts as **TEAM** so "message the team" reaches all of them.

## What JARVIS can do

| Say… | What happens |
|---|---|
| "Schedule a meeting with Bruce Banner tomorrow at 4 PM about the gamma readings" | Google Calendar event with title, time and description. It is highlighted in the Calendar preview. |
| "What do I have scheduled for tomorrow?" | Reads that day's events and opens the Calendar pane. |
| "Cancel the meeting with Bruce tomorrow" | Finds the event and asks for confirmation before deleting it. |
| "Remind me to check the Mark 50 at 7 PM" / "…tomorrow morning about the reactor test" | Personal reminder, shown in gold so it's clearly separate from cyan calendar events. |
| "What reminders do I have today?" | Lists active reminders. Due reminders pop an alert (plus voice, a desktop notification and Telegram if configured), with Done / Snooze. |
| "Upload this research report to my Drive" | Opens the uplink console: pick a file, choose an existing folder or create a new one (defaults to My Drive). It shows a live progress bar and lets you retry on failure. |
| "Upload this to a new folder called Mark 85 Schematics" | Upload console opens with the new-folder option pre-filled. |
| "Find the reactor design report" | Drive search showing name, type, folder location, last modified time and an **Open** link. |
| "Send Bruce a message saying the experiment is postponed" | Resolves the contact and writes the message. You can edit and authorise it before it's sent, and delivery status is logged in Comms. |
| "Schedule the Stark team meeting for tomorrow at 6 PM, remind me 30 minutes before it, and send Bruce a Telegram message about it" | Three steps run in order, each with live status, and the preview updates after each one. |

If something is missing ("Schedule lunch with Pepper"), JARVIS asks a follow-up question ("When should I schedule…?") and merges your answer with the original request.

### Queue vs. Interrupt
The **When busy** switch under the console controls what happens when you send a command while another is running:
- **Queue** (default): the new command joins the *Execution Queue* strip. Any queued item can be **dropped**, and the running one **aborted**.
- **Interrupt**: the running command is cancelled. Steps that haven't started are skipped and logged as *interrupted*, and the new command runs immediately.

### Safety and error handling
- Sending messages, cancelling events and deleting reminders always require confirmation. Calendar creation can be made to require it too (`CONFIRM_EVENTS=1`).
- Every failure has a code (`INTEGRATION_UNAVAILABLE`, `AUTH_EXPIRED`, `MISSING_FIELD`, `CALENDAR_FAILED`, `UPLOAD_FAILED`, `SEND_FAILED`, `NOT_FOUND`). The UI shows it on the step that failed, with a fitting action: *Reconnect Google*, *Setup help*, *Manage contacts* or *Retry*.
- The **Activity** tab records every operation JARVIS attempted (success, failed, declined, interrupted). **Comms** shows every Telegram message with its recipient, text, time and delivery status.

## Architecture

```
public/            vanilla JS + CSS HUD (no build step)
  app.js           queue engine, step tracker, preview panes, dialogs, voice I/O, SSE client
server.js          Express API, OAuth callback, SSE stream, reminder scheduler
lib/planner.js     LLM planner (Gemini or Claude) — structured JSON output → ordered steps
lib/gemini.js      Gemini REST client with automatic model selection
lib/ruleParser.js  offline fallback parser (chrono-node date parsing, multi-clause splitting)
lib/actions.js     prepare() (validate, resolve targets, confirmation) + execute() per action
lib/google.js      Calendar + Drive (OAuth2, token persistence, error mapping)
lib/telegram.js    Bot API, contact sync, delivery logging
lib/store.js       JSON-file persistence (data/db.json)
```

**Command pipeline:** `POST /api/plan` → for each step: `POST /api/prepare` → (confirm dialog | upload console) → `POST /api/execute`.
Each command runs inside an `AbortController`, which is how Abort and Interrupt cancel in-flight requests and open dialogs. Server events (`/api/stream`) keep the preview pane in sync and deliver due reminders.

Extras: voice input (Web Speech API), spoken replies in a British voice (speaker toggle), and a responsive layout that switches to Console / Live Preview tabs on phones.
