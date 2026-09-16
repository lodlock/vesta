# Changelog

All notable changes to Vesta are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Fase 6 — MCP + Advanced begins with a local MCP server: expose Vesta's on-device
tools to an agent on your laptop (Claude Code / Desktop), with the private data
never leaving the phone. Plus a hardening pass for scheduling-focused use:
deterministic parsing of spoken timers and alarms, verified model downloads, a
loopback-only MCP server, and a smaller permission set.

### Added — Fase 6

- **Local MCP server (slice 1)** — a Model Context Protocol server that a laptop
  agent can call. It exposes exactly the three read-only tools
  (`get_calendar_events`, `search_contacts`, `query_document`) and returns their
  structured data, not a generated answer: over MCP the host agent does the
  reasoning, so Vesta skips the orchestrator's generation loop and hands back the
  raw tool result (for `query_document`, the retrieved passages). Off by default;
  enabled from a new **Settings → MCP Server** screen.
- **Per-client bearer tokens** — pairing is token-issuance-only: mint a named
  client to get a copy-paste `claude mcp add --transport http … --header
  "Authorization: Bearer …"` command, revoke it to cut access instantly. Tokens
  are owned in SQLite by the TypeScript layer (migration v3, `mcp_clients`) and
  pushed into the native server's in-memory set — the native HTTP layer never
  opens the database.
- **Minimal native transport** — a NanoHTTPD server in the Android layer
  (`POST /mcp`, JSON-RPC 2.0, no SSE) is a dumb transport + auth gate: it checks
  the bearer token, forwards the raw request body to JS over the same
  device-event bridge as the memory-pressure signal, and blocks on a
  `CompletableFuture` until the TypeScript MCP engine responds. Single-client by
  design. (Shipped binding `0.0.0.0`; now binds loopback — see Security below.)

### Fixed — models

- **An NPU bundle could not be loaded: `failed to open file: null`** — a QAIRT
  session was created with a tokenizer path of `"null"`, the four-character
  string, and the Qualcomm plugin duly tried to open a file by that name.
  Android's `org.json` is the cause: `optString(key, fallback)` returns
  `JSON.toString()` of the `JSONObject.NULL` sentinel — `"null"` — and never
  takes the fallback branch, so the bridge read a `tokenizerPath: null` sent by
  the TypeScript side as a real path and the "look beside the weights" fallback
  never ran. The bridge now distinguishes an absent value from a supplied one,
  the load request no longer puts nulls on the wire, and the tokenizer fallback
  names a file only when that file is actually there — an empty path leaves
  GenieX to run its own search over the bundle. A load attempt now also logs
  every `ModelPaths` field and both paths the session was created with, quoted,
  so an absent value can never again be mistaken for the word "null".

- **Downloaded models could become unselectable with no way back** — a model
  left in an errored state (a failed load, or a recorded size that no longer
  matched) showed no explanation on the catalog card and no action except
  Delete, so the only visible difference was its trust label. Trust was never
  the cause: nothing gates activation on it. Both the Models screen and
  `activate()` now read ONE policy (`lib/models/activation`), so a row that
  looks selectable is, and one that isn't says why.
- **Verify now repairs instead of just reporting** — for a model downloaded
  from a repo, it fetches that file's published SHA-256, hashes the copy on
  disk, and on a match records `verified_upstream` and makes the model usable
  again. No re-download, and nothing is deleted. A mismatch errors the model
  and never activates it. If no digest can be obtained — the repo publishes
  none, or it can't be reached — the model stays explicitly unverified rather
  than being credited with a check that didn't happen.
- **Embedding models are no longer offered as the chat model** — Nomic Embed
  showed "Use this model", which would have loaded an embedding model into the
  chat context and left it unable to answer anything.

### Added — assistant

- **The assistant answers anything now** — a request the scheduling parser
  declines goes to the local model automatically instead of stopping at a
  button. Scheduling still never loads it, and a clarification is still handled
  locally; the model comes in only once the parser has actually given up.
  Two settings, both default ON: "Answer anything" and "Speak answers".
- **Spoken answers** — confirmations and answers are read back through the
  Android system TTS engine (no cloud voice). One utterance at a time: a new
  invocation or a dismissal cuts off the previous one. Successful timers,
  alarms and reminders speak their confirmation and then dismiss the overlay,
  returning you to whatever you were doing; failures, questions and model
  answers stay on screen.
- **An NPU build raises minSdk to 27; a default build stays at 24** — the
  GenieX AAR declares `minSdkVersion 27`, and the manifest merger errors rather
  than warns on a lower app floor. `VESTA_ENABLE_NPU=1` now writes
  `android.minSdkVersion=27` into `android/gradle.properties`, which is the
  value the app module *and* every library module resolve from; a prebuild
  without the flag removes it again. Not `tools:overrideLibrary`: that would
  hide the error and ship an APK still claiming API 24 to devices the Qualcomm
  runtime cannot load. API 27 is the linking floor only — real NPU inference
  needs Android 15+, Hexagon v73+ and an SoC-matched bundle, and the backend
  still declines to llama.cpp otherwise. See docs/NPU-BACKEND.md.
- **Assistant turns are kept only when they are worth reopening** — a
  deterministic action (timer, alarm, reminder) writes no conversation: the
  timer is the outcome, and Done or the auto-dismiss leave nothing behind.
  A model-backed answer is saved the moment it appears — before it is spoken,
  and therefore before the overlay can close itself — so a timeout or a killed
  process cannot lose it. A clarification follows whichever path it ends on.
  **Open Chat** saves the turn if it is not already saved and opens *that*
  conversation, never the one that happened to be open in the app beforehand,
  and a tap that races the automatic save produces one chat, not two. Only the
  visible text is stored: no reasoning, no tool-call JSON. See ADR-023.
- **No reasoning on screen or out loud** — assistant turns disable the model's
  thinking pass at generation time, use llama.rn's reasoning-filtered output,
  and sanitize whatever is left. Leaked tool-call JSON is stripped too. Ordinary
  chat is unchanged.
- **Two-backend seam** (`lib/llm/backends`) — `ModelBackend` with
  `LlamaCppBackend` and a declared-but-unimplemented `QualcommNpuBackend`, so a
  future NPU runtime can sit beside llama.cpp rather than replace it. Selection
  is first-match-wins with llama.cpp last, so any GGUF — including your own —
  always has a runtime. See ADR-021.

- **Vesta can be the system digital assistant** — it now handles
  `ACTION_ASSIST`, which is what makes a package a `ROLE_ASSISTANT` candidate,
  so it appears under Settings → Default apps → Digital assistant app. It
  previously declared neither an assist activity nor a `VoiceInteractionService`
  and so was never listed. Settings → Digital assistant opens the system
  chooser; Vesta never sets itself as the default.
- **The assistant gesture goes straight to a spoken command** — transparent
  voice activity → the system recognizer (FUTO or whatever the user chose) →
  the deterministic scheduling parser → the Android timer/alarm/reminder
  intent. No chat screen, and **no GGUF**: an assistant launch boots with
  `loadModel: false`, so "set a 30 second timer" reaches the clock app without
  the weights entering memory. The model is loaded only if the user taps the
  fallback, which only appears once the parser has declined the utterance.
  A clarification ("4 AM or 4 PM?") can be answered by voice — the answer
  completes the original sentence, so it still resolves without a model.
- No new permissions: an `ACTION_ASSIST` assistant needs none, and
  `VESTA_SCHEDULING_ONLY=1` builds are unchanged. No hotword, no background
  capture — the microphone opens only inside the recognizer the user invoked.

### Added — scheduling

- **Deterministic scheduling parser** (`lib/scheduling`) — timers, alarms,
  reminders and calendar events are now resolved from the transcript itself,
  before the model is consulted. It tolerates what dictation actually produces:
  fillers ("set a **uh** set a five five minute timer"), stammered repeats, and
  mid-sentence self-corrections ("alarm for eight… **no, eight thirty
  tomorrow**", "wake me tomorrow at seven… **actually seven fifteen**"), taking
  the corrected value while keeping a qualifier the correction didn't restate.
  Resolves to a small structured intent — `timer(durationSeconds, label?)`,
  `alarm(time, date?, label?)`, `reminder(dateTime, text)`,
  `calendarEvent(start, title)` — which maps onto the existing tool call, the
  existing confirmation gate and the existing Android intents. English and
  Italian.
- **Timer plus an earlier warning, in one command** — "give me forty-five
  minutes, but remind me five minutes before too", "warn me ten minutes before",
  "with a five-minute warning", "a warning at forty" all set two timers (the
  warning first) instead of asking which one you meant. "N before" counts back
  from the end, "at M" is the warning's own length, and bare numbers in this
  shape are minutes when no unit is spoken at all — so "timer for forty-five,
  warning at forty" works with no unit words in it. A bare warning number
  otherwise borrows the timer's unit: "give me two hours, warn me at one" is a
  one-HOUR warning, not one minute.
- **Asks instead of guessing** — a recognized scheduling command that isn't
  safely resolvable still asks: missing duration/time/subject, a bare "twelve",
  two genuinely different actions ("an alarm for seven and a timer for ten
  minutes"), a warning with nothing to measure ("warn me before the timer"), an
  implausible length. Anything it doesn't recognize as scheduling goes to the
  model exactly as before.
- **A bare hour resolves to the next plausible occurrence** — of the two
  readings, whichever comes sooner, rolling past midnight when both have passed.
  "Alarm for four" is 04:00 said at 02:00 and 16:00 said at 13:00. An explicit
  am/pm, a part-of-day word and a wake-up phrasing take precedence.
- **A named future day with a bare hour asks instead of guessing** — "alarm
  tomorrow at four" now asks "4 AM or 4 PM?" rather than picking one. With a
  clock to lean on the next-occurrence rule is safe; across a day boundary it
  is a coin flip, and an alarm that is twelve hours wrong is worse than one
  more question. "Tomorrow at four in the morning", "tomorrow at four PM",
  "tomorrow at 16:00" and "wake me tomorrow at seven" all still resolve
  straight away, and "today at four" keeps the next-occurrence rule.
- **Scheduling works with no model loaded** — a timer or an alarm still runs
  while a model is downloading or failed to load.
- Sub-minute timers are confirmed as "30 seconds" rather than "0.5 minutes".

### Security

- **The MCP server binds `127.0.0.1` by default** — it previously bound every
  interface, putting a plaintext bearer token and the read tools' output
  (calendar, contacts, document passages) on whatever Wi-Fi the phone was on.
  LAN exposure is now a separate, explicitly confirmed opt-in; the pairing
  command for the default case leads with `adb reverse tcp:8420 tcp:8420`. The
  server remains off by default.
- **Downloaded models are verified by SHA-256, and verification fails closed** —
  the finished file is hashed (natively, streaming) and compared against
  HuggingFace's LFS oid *before* the rename that promotes it to the model
  directory. Previously only the file size was checked, so a substituted or
  corruptly-resumed file could be loaded as weights. When a digest was
  published, the download commits only on a match: a mismatch, a hashing error
  and hashing being unavailable all quarantine the file and fail. A repo that
  publishes no digest is a different case — that installs, labelled unverified.
- **Model trust levels** — a model now records *which* claim applies to its
  bytes (`verified_upstream`, `verified_user_checksum`, `user_supplied_baseline`,
  `unverified`) instead of a flat verified/unverified, and the Models screen
  states each in its own words.
- **Imported GGUFs keep full support, with optional verification** — a file you
  downloaded elsewhere, merged or quantized yourself still imports through the
  system file picker with no HuggingFace repo or catalog filename required. You
  can give it a SHA-256 (pasted, or an adjacent `.sha256`) and then it must
  match; with none, the import proceeds and Vesta hashes it as a baseline, so a
  later change to the file is detectable — `activate()` rejects a model whose
  size no longer matches, and a Verify action re-hashes on demand. Imports also
  get a cheap GGUF header check (magic, version, plausible counts, truncation)
  before llama.cpp opens the file, and never write over an existing model file:
  two models can share a name, so a colliding import takes a free one.
- **Fewer Android permissions** — `SYSTEM_ALERT_WINDOW`, `WRITE_CONTACTS`,
  `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` were reaching the
  generated manifest from the Expo template and from `expo-contacts` without any
  Vesta code path using them; they are now stripped (including from library
  manifest merges). A new `VESTA_SCHEDULING_ONLY=1` prebuild also drops
  `READ_CONTACTS`, for a build that only does scheduling.
- `SECURITY.md` no longer claims Vesta has "no network communication": it now
  documents the two real paths (HuggingFace model downloads out, the optional
  loopback MCP server in) and states plainly that there is no telemetry, no
  analytics, no crash reporting and no cloud inference.

### Fixed

- **Voice input language** — the system recognizer was handed a `Locale` object
  where `EXTRA_LANGUAGE` is read as a string, so recognizers saw `null` and fell
  back to their own default language. It now receives an IETF language tag.
  Vesta continues to use the Android system recognizer (so FUTO Voice Input and
  any other user-chosen engine keep working) and ships no STT of its own.

## [0.2.0] — 2026-07-07

Fase 5 — Reliability & Release, plus the on-device performance work from Fase 4.
Signed APKs are now published to GitHub Releases.

Fase 5 — Reliability & Release begins with silent-failure elimination: a
persistence write that failed used to only log to the console, so a message or
reply that didn't reach SQLite vanished on the next restart with no signal.

### Fixed — Fase 5

- **Persistence failures are now surfaced** — every failed database write in the
  chat flow (user message, assistant reply, pending confirmation, tool result)
  raises a dismissible amber notice ("Couldn't save to storage — this message
  may be lost if you restart") instead of only a `console.error`. The in-memory
  turn is unaffected; the user just learns it may not survive a restart.
- **Honest startup state** — when a selected model fails to load at boot (e.g. a
  transient low-memory start), the chat now says "Couldn't load <model> — open
  Models to retry" instead of showing the misleading "no model — tap to
  download" banner for a model that is actually installed.

### Added — Fase 5

- **On-device diagnostics screen** — a new Settings → Diagnostics page showing
  the active model (name, file, context size, KV-cache type), the last turn's
  prefill time and prompt-token count (the local proxy for KV-cache reuse — a
  warm append evaluates few tokens, a cold turn many), and the on-disk footprint
  (database and prefix session cache). All read locally; nothing is sent
  anywhere. The offline-first substitute for telemetry.
- **Long conversations stay fast (anchored history window)** — the history
  window used to re-slice to the last 20 messages every turn, so a conversation
  past 20 messages re-prefilled the whole window each turn. The window start is
  now anchored to an 8-message stride, so it only jumps occasionally; between
  jumps a long chat stays a pure KV-cache append (the same win short chats
  already had), cutting re-prefills on long conversations by roughly 4x.
- **Regression tests for the last uncovered on-device bug classes** — the schema
  migration runner (fresh DB reaches the latest version, migrations applied in
  order, each atomic, idempotent on re-run) and the resumable downloader
  (truncated files rejected, pause/resume tokens honored, a cancel race never
  commits a partial). Brings the suite to 176 tests.
- **Memory-pressure handling** — Android delivers low-memory warnings through
  native `onTrimMemory` (React Native's `AppState` `memoryWarning` event never
  fires on Android), so `SystemActionsModule` now hooks it and forwards real
  pressure to JS, which releases the embedding context (~1s to reload). The chat
  model stays resident by design; if the OS still reclaims the process, the
  foreground service restarts it and the prefix session cache keeps the cold
  start cheap.
- **`NoticeBanner`** — a reusable, auto-dismissing amber banner for non-fatal
  notices, distinct from the red fatal-error banner.

Fase 4 — On-device Performance makes Vesta dramatically faster on the phone,
all measured on a Pixel 10 Pro with Qwen3 4B: warm turns went from a full
prompt re-prefill (~67s) to flat ~6s pure KV-cache appends, and the first
message after a cold app start went from 37.3s to 2.8s (13.4x).

### Added — Fase 4

- **KV-cache-friendly prompt architecture** (#18, #22) — the system prompt is
  now fully static (persona, rules, tool schemas, memories, knowledge) and the
  current date rides in a `[Time context: ...]` line prepended to each user
  message, rendered from that message's stored timestamp. Conversation history
  replays byte-identically, so every turn is a pure KV-cache append instead of
  a re-prefill. No tool-accuracy regression (Fase 0 benchmark: 98.9% tool /
  100% JSON).
- **Cold-start prefix session cache** (#20) — the KV state of the stable
  prompt prefix is saved to disk after the first clean turn and restored right
  after model load, cutting the first message from 37.3s to 2.8s. Keyed by
  model + settings + prefix text; any change invalidates it; a corrupted file
  self-heals into a normal cold start. Saves are debounced (llama.cpp
  serializes the full KV state, ~215 MB per file).
- **Performance settings** (#17) — user-tunable CPU threads, KV-cache q8_0
  quantization + flash attention (halves KV memory, ~1.5x slower on CPU), and
  mlock. All default OFF; the Settings hint states the trade-off.
- **Prefill benchmark dev command** (#20, #22) — `/benchmark-prefill` measures
  the three prompt layouts back-to-back on device via `timings.promptMs`.

### Fixed — Fase 4

- **Duplicate user message** (#22) — since Fase 1, the current user message
  reached the model twice (once in history, once appended). Fixed and locked
  by a history-stability test suite.
- **Memory extraction no longer evicts the chat KV cache** (#18) — it now
  appends to the conversation (sharing the cached prefix) instead of running
  as a standalone prompt, and its timeout can no longer cancel the user's next
  generation.

Fase 3 — Document Intelligence adds on-device RAG. Import a PDF, Word (.docx),
text, or Markdown file; Vesta extracts and chunks the text, embeds it with a
local Nomic model, and answers questions grounded in it via brute-force cosine
retrieval — all offline. Verified on a Pixel 10 Pro, PDF included.

### Added — Fase 3

- **`query_document` tool** — a read tool that runs through the orchestrator
  query loop: embed the question, cosine-rank the stored chunk vectors, and
  answer from the top matches. A relevance floor returns "nothing relevant"
  instead of confabulating when a question isn't covered by the documents.
- **Documents screen** — import PDF / DOCX / TXT / MD with per-chunk indexing
  progress, list, and delete. Parsing via `pdfjs` (PDF, with Hermes DOM
  polyfills), `jszip` (DOCX), and direct read (TXT/MD). No `sqlite-vec`
  dependency — vectors are brute-force cosine-scanned in TypeScript.
- **On-device embeddings** — a second `llama.rn` context runs the Nomic embed
  model alongside the chat model, and is reclaimed when the app backgrounds.

Fase 2 — Core Polish complete. All 10 core tools and the orchestrator query
loop are implemented and verified on real hardware (a Pixel 10 Pro): timers,
calendar read, and contact search run fully offline against real on-device
data, with calls/SMS gated behind explicit confirmation. See
[docs/GAMEPLAN.md](docs/GAMEPLAN.md).

### Added

- **Six more system tools**, completing the Fase 2 set: `set_timer`,
  `navigate_to` (#11); `search_contacts`, `make_call`, `send_sms`, and
  `get_calendar_events` (#13). All 10 tools work offline via native Android
  intents or `ContentResolver` queries, with destructive actions gated by an
  explicit confirmation step.
- **Orchestrator query loop** — read tools (`get_calendar_events`,
  `search_contacts`) execute inline, so questions like "che appuntamenti ho
  domani?" are answered in natural language from real on-device data.
- **Malformed-JSON recovery** — when the model emits an unparseable or truncated
  tool call, the orchestrator retries once with a correction prompt that asks
  for the JSON object only, then falls back to a plain reply if it still fails
  (the Fase 2 exit-gate requirement).
- **Honest tool-result messages** (#12) — `set_alarm` no longer claims a
  future date (Android arms only the next occurrence), and `create_event`
  reports that the calendar editor opened rather than falsely claiming the
  event was saved.
- **Cancellable memory extraction** (#12) — a background memory-extraction
  pass is now stopped when the user sends a new message, so a background LLM
  run never blocks the next turn; memory injection no longer self-reinforces
  the ranking.
- **Bilingual** IT/EN coverage extended to all 10 tools' prompts and
  confirmation messages.

## [0.1.0] — 2026-06-25

First public release — Fase 1 Android MVP. The core loop works end-to-end on
real hardware: load a model, chat, and trigger system actions fully offline.

### Added

- **On-device chat** with any GGUF model via [llama.rn](https://github.com/mybigday/llama.rn) (llama.cpp). Works in airplane mode.
- **In-app model manager** — curated, RAM-aware catalog with download (progress, resume, cancel); add any public HuggingFace GGUF repo; import a local `.gguf`; switch or delete the active model.
- **System actions** through native Android intents — set alarm, create calendar event, and schedule reminder (as a local notification), each gated by an explicit confirmation step.
- **Conversation memory** — personal facts extracted and stored locally in SQLite, injected into future prompts for continuity.
- **Knowledge files** — import `.md` / `.txt` files as portable, offline personal context.
- **Conversation history** — full persistence with SQLite: browse, switch, and delete past chats.
- **Home-screen widget** — 2×2 widget with a quick-chat bar and voice entry.
- **Foreground service** keeps the model resident in RAM between turns.
- **Bilingual** English and Italian system prompts.

### Notes

- Repetition penalty and a hardened Stop control were added after the first
  on-device test (a long free-text answer could otherwise loop, and Stop could
  throw on a JSI quirk in `llama.rn`).
- `ACTION_SET_ALARM` sets the next occurrence of a time; specific future-dated
  alarms are out of scope for the MVP. The tool result now states this honestly.
