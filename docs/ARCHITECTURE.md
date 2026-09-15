# Vesta — Architecture Document

**Version:** 3.0
**Data:** 7 Luglio 2026
**Autore:** Cosmico Engineering
**Status:** Living document — allineato all'implementazione (Fase 0–4)
**Tagline:** *Intelligence that never leaves home.*

> Questo documento descrive l'architettura COME IMPLEMENTATA e verificata su device
> (Pixel 10 Pro) attraverso le Fasi 0–4. Le decisioni sono tracciate negli ADR (§7):
> dove la realtà ha superato il design originale di marzo, l'ADR corrispondente è
> marcato come superato o emendato.

---

## 1. Principi Architetturali

Ogni decisione in questo documento deriva da cinque principi, in ordine di priorità:

1. **Offline-first**: ogni feature DEVE funzionare senza internet. Se richiede rete, è un enhancement, non un requisito.
2. **Model-validated**: nessuna infrastruttura viene costruita prima che il modello dimostri di poter eseguire il task. I dati guidano le decisioni, non le intuizioni.
3. **Layer independence**: ogni layer funziona indipendentemente. Se rimuovi il RAG, l'assistente risponde. Se rimuovi le System Actions, resta un chatbot locale.
4. **Minimal native**: il codice nativo (Kotlin) è limitato al minimo necessario (Intents di sistema, Foreground Service, widget/voce). L'inferenza LLM arriva via llama.rn (binding React Native di llama.cpp). Tutto il resto è TypeScript cross-platform.
5. **Single runtime**: un solo motore di inferenza (llama.cpp, via llama.rn) per testo E embedding. Zero runtime aggiuntivi.

---

## 2. Panoramica del Sistema

```
┌─────────────────────────────────────────────────────────────────┐
│                DEVICE (Android — iOS parcheggiato)                │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    React Native App (TypeScript)             │ │
│  │                                                              │ │
│  │  ┌──────────┐  ┌──────────────┐  ┌───────────────────────┐ │ │
│  │  │  Chat UI  │  │  Documents /  │  │  Models / Settings /  │ │ │
│  │  │           │  │  Knowledge    │  │  History              │ │ │
│  │  └────┬─────┘  └──────┬───────┘  └───────────────────────┘ │ │
│  │       │               │                                      │ │
│  │  ┌────▼───────────────▼──────────────────────────────────┐  │ │
│  │  │              ORCHESTRATOR (TypeScript)                  │  │ │
│  │  │                                                        │  │ │
│  │  │  Message ──► Prompt Builder ──► LLM ──► Parser ──►     │  │ │
│  │  │              (V4: static prefix)        Tool Dispatcher │  │ │
│  │  │                                         (+ confirm gate)│  │ │
│  │  └────────────┬───────────────┬───────────────────────────┘  │ │
│  └───────────────┼───────────────┼──────────────────────────────┘ │
│                  │               │                                 │
│  ┌───────────────▼───────────────▼──────────────────────────────┐ │
│  │                      NATIVE LAYER                             │ │
│  │                                                                │ │
│  │  ┌────────────────┐  ┌─────────────────┐  ┌───────────────┐  │ │
│  │  │  llama.rn      │  │  SystemActions   │  │  VestaService │  │ │
│  │  │  (llama.cpp)   │  │  (Kotlin)        │  │  (Kotlin FGS) │  │ │
│  │  │                │  │                   │  │               │  │ │
│  │  │  - chat ctx    │  │  - alarm/timer    │  │  - keep-alive │  │ │
│  │  │  - embed ctx   │  │  - calendar r/w   │  │    notification│ │ │
│  │  │  - save/load   │  │  - contacts       │  │  + Widget &   │  │ │
│  │  │    session     │  │  - dial/sms       │  │    Voice      │  │ │
│  │  └────────────────┘  │  - navigation     │  │    activities │  │ │
│  │                      └─────────────────┘  └───────────────┘  │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    LOCAL STORAGE                               │   │
│  │                                                                │   │
│  │  ┌────────────────────────────┐  ┌──────────────────────┐    │   │
│  │  │  SQLite (expo-sqlite)      │  │  File storage        │    │   │
│  │  │  messages, conversations,  │  │  - modelli .gguf     │    │   │
│  │  │  memories, knowledge_files,│  │  - session cache     │    │   │
│  │  │  config, models, documents,│  │    (prefix KV state) │    │   │
│  │  │  chunks (embedding BLOB)   │  │                      │    │   │
│  │  └────────────────────────────┘  └──────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘

           Mac Hub (LAN, 70B via Ollama + WebSocket + mDNS)
           ⏸️ PARCHEGGIATO — re-scope Android-first, vedi §6 e GAMEPLAN.md
```

---

## 3. Componenti in Dettaglio

### 3.1 Chat UI (React Native)

Interfaccia chat minimale. Non è il differenziatore del prodotto — l'intelligenza lo è.

**Responsabilità**: input testo, rendering messaggi (markdown), step di conferma per le azioni, picker documenti/knowledge, indicatore stato modello, pulsante Stop.

**NON responsabilità**: nessuna logica di business, nessun accesso diretto al modello, nessuna gestione stato conversazione (sta nello store Zustand + orchestrator).

**Input vocale**: opzionale, via il widget home-screen — un'activity trasparente delega al riconoscitore vocale di sistema (`RecognizerIntent.ACTION_RECOGNIZE_SPEECH`) e re-inietta il testo via deep link. Nessun modello STT in-app.

**Librerie chiave**: `react-native` + `expo` (Expo Router), `expo-document-picker`, `zustand`.

### 3.2 Orchestrator (TypeScript, cross-platform)

Il cuore logico dell'applicazione. Puro TypeScript senza dipendenze native.

```
Messaggio utente (+ createdAt)
       │
       ▼
┌───────────────────────┐     ┌───────────────────────────────┐
│  annotateUserMessage   │     │  buildStablePrefix (STATICO)   │
│  [Contesto temporale:  │     │  persona + regole + tool       │
│   ...] dal createdAt   │     │  schemas + memorie + knowledge │
└──────────┬────────────┘     └──────────────┬────────────────┘
           │                                  │
           └────────────┬─────────────────────┘
                        ▼
             ┌──────────────────────┐
             │  llama.rn completion │   history byte-identica →
             │  (chat context)      │   ogni turno è un puro
             └──────────┬───────────┘   append sulla KV cache
                        ▼
             ┌──────────────────────┐
             │  Response Parser     │
             │  JSON tool call?     │
             │  ├─ YES → validate + │
             │  │   normalize params│
             │  │   → confirm gate  │
             │  │   → dispatch tool │
             │  │   → (read tools:  │
             │  │      query loop)  │
             │  └─ NO → text reply  │
             │  JSON malformato →   │
             │  retry 1x correzione │
             │  → fallback testo    │
             └──────────────────────┘
```

**Moduli chiave** (`apps/mobile/lib/orchestrator/`):

- `orchestrator.ts` — entry point, flusso messaggio→risposta, query loop dei read tools, retry JSON
- `prompt-builder.ts` — prefisso stabile V4 + `buildTurnContext`/`annotateUserMessage` (vedi §4.3)
- `response-parser.ts` — parsing tool-call JSON vs testo libero
- `tool-dispatcher.ts` — validazione/normalizzazione parametri, dispatch verso i moduli nativi
- `memory-manager.ts` / `memory-gate.ts` — estrazione e ranking dei fatti a lungo termine
- `knowledge-manager.ts` / `knowledge-format.ts` — file .md/.txt come contesto personale
- `document-retriever.ts` — retrieval RAG (cosine brute-force, soglia 0.28)
- `session-warmer.ts` — warm/restore della session cache al boot (vedi §4.3)
- `date-utils.ts` — date math locale (no UTC drift a mezzanotte)

I read tools (`get_calendar_events`, `search_contacts`, `query_document`) sono marcati `returnsData`: il risultato viene re-iniettato e il modello genera una risposta groundata sui dati reali (query loop).

### 3.3 Native Layer

Il layer sottile che collega TypeScript al sistema operativo.

**Principio**: il layer nativo è STUPIDO. Non contiene logica di business. L'intelligenza sta nell'orchestrator.

#### 3.3.1 LLM Engine (llama.rn)

L'inferenza NON usa un bridge NDK scritto in casa: usa **llama.rn** (binding React Native ufficiale di llama.cpp, ~0.11.x), che compila llama.cpp per arm64 e lo espone via JSI. Il wrapper TypeScript sta in `apps/mobile/lib/llm/`:

```
┌──────────────────────────────────────────────────────┐
│              llm-engine.ts (chat context)              │
│                                                        │
│  loadModel(path, perfConfig) → initLlama               │
│  generate(messages, onToken) → completion (streaming)  │
│  stopGeneration()                                      │
│  snapshotPrefixSession / loadSessionFile               │
│    (saveSession/loadSession per la prefix cache)       │
│  clearKvCache(), getModelInfo(), unloadModel()         │
│                                                        │
│  perf-config.ts: threads, KV-cache q8_0 + flash        │
│  attention, mlock (opt-in, default OFF)                │
├──────────────────────────────────────────────────────┤
│              embed-engine.ts (embed context)            │
│                                                        │
│  SECONDO contesto llama.rn con nomic-embed-text:       │
│  embed(text) → Float32Array (L2-normalized)            │
│  Rilasciato quando l'app va in background,             │
│  ricaricato lazy al prossimo uso.                       │
└──────────────────────────────────────────────────────┘
```

Due proprietà architetturali decisive, misurate su device:

- **KV-cache prefix reuse**: llama.rn riusa la KV cache in-memory per il più lungo prefisso di token comune tra completion consecutive. L'intera struttura del prompt (§4.3) è progettata attorno a questo fatto.
- **Niente grammar constraint**: il JSON dei tool call è ottenuto via prompt engineering (schema iniettato nel system prompt) + parsing. Se il JSON è malformato, un singolo retry con prompt di correzione, poi fallback a testo libero. Accuratezza misurata: 98.9% tool / 100% JSON (Fase 0, easy+medium, thinking).

Su Pixel (Tensor G5) l'inferenza è CPU-bound; su Adreno (Snapdragon) il backend GPU di llama.cpp accetta solo quant `Q4_0`/`Q6_K`.

**iOS (parcheggiato)**: MLX-Swift era il candidato; nessun codice esiste.

#### 3.3.2 System Actions (Kotlin)

```
┌──────────────────────────────────────────────────┐
│              SystemActionsModule                   │
│                                                    │
│  setAlarm(time, label?)   → AlarmClock.ACTION_SET_ALARM
│  setTimer(seconds, label?)→ AlarmClock.ACTION_SET_TIMER
│  createEvent(...)         → Intent.ACTION_INSERT (calendar)
│  getCalendarEvents(date)  → CalendarContract via ContentResolver
│  searchContacts(query)    → ContactsContract via ContentResolver
│  makeCall(number)         → Intent.ACTION_DIAL (nessun permesso: l'utente preme "chiama")
│  sendSMS(number, text)    → Intent.ACTION_SENDTO (l'utente preme "invia")
│  navigate(destination)    → Intent.ACTION_VIEW (google.navigation)
│                                                    │
│  Result: { success, message, error? }              │
└──────────────────────────────────────────────────┘
```

**Nota**: `set_reminder` NON passa da qui — usa `expo-notifications` (notifica locale schedulata, lato TypeScript in `lib/native/reminders.ts`). Vedi ADR-009.

Il codice Kotlin vive in `apps/mobile/native/android/` e viene copiato/registrato nel progetto Android da un config plugin Expo (`plugins/with-system-actions.js`) durante il prebuild.

#### 3.3.3 VestaService (Foreground Service, Kotlin)

Servizio Android `specialUse` con notifica persistente a bassa priorità. Fa UNA cosa: tiene vivo il processo (START_STICKY) così il modello resta caricato tra un turno e l'altro, e aggiorna il testo della notifica ("Modello pronto" / "Caricamento…").

**Cosa NON fa (design deliberato, vedi ADR-015)**: nessuno scaricamento automatico del modello dopo N minuti di inattività. Il modello chat resta residente finché il servizio vive; ricaricarlo costerebbe secondi e (senza session cache) decine di secondi di re-prefill. Il contesto di EMBEDDING invece viene rilasciato quando l'app va in background (è ricaricabile in ~1s ed è usato solo durante import/query documenti).

**Widget + Voce**: un widget home-screen 2×2 (quick-chat + microfono) e una activity trasparente per l'input vocale di sistema completano il layer Kotlin.

### 3.4 Local Storage

#### 3.4.1 SQLite (expo-sqlite)

Database unico (`vesta.db`) per tutti i dati strutturati. Migrazioni via `PRAGMA user_version` + array `MIGRATIONS` applicato in transazione atomica (schema + bump versione insieme). Versione schema corrente: **2**.

Tabelle: `messages`, `conversations`, `memories`, `knowledge_files`, `config` (baseline), `models` (v1 — catalogo/download), `documents` + `chunks` (v2 — RAG). Schema completo in SPEC.md §2.

#### 3.4.2 Embeddings e retrieval (niente sqlite-vec)

Il design originale prevedeva sqlite-vec come estensione SQLite (ADR-003). **Non è stato possibile**: expo-sqlite non può caricare estensioni native. La soluzione implementata (ADR-008):

- gli embedding (nomic-embed-text-v1.5, 768 dimensioni, L2-normalized) sono salvati come **BLOB float32** nella tabella `chunks`;
- il retrieval è una **scansione brute-force con cosine similarity in TypeScript** (`lib/documents/similarity.ts`), con soglia di rilevanza 0.28 sotto la quale si risponde "niente di rilevante" invece di confabulare;
- a scala telefono (decine di documenti, migliaia di chunk) la scansione è ampiamente sotto il costo di un singolo token di inferenza — verificato su device.

#### 3.4.3 Model files e session cache

File `.gguf` nello storage locale dell'app, scaricati dall'utente via catalogo in-app / repo HuggingFace / import locale. Non inclusi nell'APK.

Accanto ai modelli vive la **prefix session cache** (`session-cache/`): lo stato KV del prefisso stabile del prompt, salvato con `saveSession` dopo il primo turno pulito e ripristinato con `loadSession` subito dopo il load del modello. Un solo file, chiave = hash(model path + kv-cache type + testo del prefisso); qualunque cambiamento (modello, memorie, knowledge, lingua, perf settings) la invalida. Attenzione al costo: llama.cpp serializza lo stato KV COMPLETO (~215 MB per Qwen3 4B f16 a ~1450 token), quindi i salvataggi sono debounced (120s) e saltati finché l'hash su disco è valido. Misurato: primo messaggio da 37.3s → 2.8s (13.4x).

---

## 4. Flusso Dati: Casi d'Uso Completi

### 4.1 "Fissa appuntamento dal dentista giovedì alle 15"

```
1.  [Chat UI] Utente digita il messaggio (createdAt = ora di invio)
2.  [Orchestrator] annotateUserMessage: prepende la riga
    [Contesto temporale: giovedì 2026-07-09T14:30 (Europe/Rome). Oggi: ... Domani: ...]
3.  [Orchestrator] Assembla i messaggi: system prompt STATICO (persona + regole +
    tool schemas + memorie + knowledge) + history (ogni messaggio utente re-annotato
    dal SUO createdAt → byte-identica al turno precedente) + messaggio corrente
4.  [llama.rn] completion in streaming — la KV cache copre tutto il prompt del
    turno precedente: viene prefillato solo il nuovo messaggio (~100 token, ~6s)
5.  [LLM Output]:
    { "tool": "create_event",
      "parameters": { "title": "Dentista", "start": "2026-07-09T15:00:00" },
      "message": "Appuntamento dal dentista fissato per giovedì alle 15:00." }
6.  [Response Parser] Valida il JSON contro lo schema del tool;
    normalizeToolParams ripara i formati vicini (es. datetime ISO su un campo date-only)
7.  [Confirm gate] L'UI mostra l'azione con Conferma/Annulla (sempre per azioni
    che modificano stato; make_call/send_sms sono sempre gated)
8.  [Tool Dispatcher → SystemActionsModule] Intent.ACTION_INSERT
9.  [Android OS] Apre l'editor evento del calendario precompilato
10. [Chat UI] Messaggio di conferma onesto ("editor calendario aperto" — non
    finge che l'evento sia già salvato)
```

### 4.2 "Cosa dice il contratto sulla clausola di recesso?" (RAG)

```
1. [Chat UI] Domanda dell'utente (documento importato in precedenza dalla
   schermata Documents: parse → chunk ~512 token → embed → BLOB in SQLite)
2. [LLM] Il modello emette { "tool": "query_document", "parameters": { "query": ... } }
   (il routing richiede un cue documentale: "nei miei documenti...", "il contratto...")
3. [embed-engine] embed("search_query: clausola di recesso ...") → Float32Array
4. [document-retriever] Cosine brute-force in TS su tutti i chunk;
   soglia 0.28 → se anche il best match è debole: "niente di rilevante"
5. [Query loop] I top chunk vengono re-iniettati come tool result e il modello
   genera una risposta groundata SOLO sugli estratti
6. [Chat UI] Risposta con riferimento al documento
```

### 4.3 Architettura del prompt (V4) e KV cache

Il vincolo che governa tutto il layout del prompt: **un solo token cambiato invalida la KV cache da quel punto in poi**. Su un phone il re-prefill del blocco tool-schema costa decine di secondi.

```
┌─ SYSTEM PROMPT — completamente STATICO (byte-identico tra i turni) ─┐
│ persona + formato JSON + regole date STATICHE + tool schemas +      │
│ memorie (ordine canonico per createdAt) + knowledge                 │
└─────────────────────────────────────────────────────────────────────┘
┌─ OGNI MESSAGGIO UTENTE (history re-renderizzata dal suo createdAt) ─┐
│ [Contesto temporale: {giorno} {datetime-minuto} ({tz}).             │
│  Oggi: {oggi}. Domani: {domani}]                                    │
│ {testo utente}                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

Conseguenze misurate (Pixel 10 Pro, Qwen3 4B):
- turni warm: da re-prefill completo (~67s, layout V2) a **puro append piatto ~6s** (V4), con `n_past` = l'intero prompt del turno precedente;
- cold start: 37.3s → 2.8s con la prefix session cache (§3.4.3);
- l'estrazione memorie viene ACCODATA alla conversazione (condivide il prefisso KV) invece di girare come prompt standalone che evicterebbe la cache (ADR-013).

Due invarianti, bloccate dai test (`prompt-builder.test.ts`, `history-stability.test.ts`):
1. mai interpolare data/ora (o qualsiasi valore per-turno) nel system prompt;
2. la history deve essere una funzione pura dei messaggi salvati — replay byte-identico per sempre.

Limitazioni note (triage Fase 5, dettagli in GAMEPLAN.md): la slide della finestra history è RISOLTA — `historyWindowStart` ancora l'inizio della finestra a uno stride di 8 messaggi, così una conversazione lunga resta un puro append tra un salto e l'altro (prima `slice(-20)` re-sliceva ogni turno). Restano accettate, perché rare e bounded: il cambio di timezone (un cold start al lancio successivo) e l'aggiornamento del suffisso `[Tool:]` alla risoluzione del confirm gate (un re-prefill una tantum).

---

## 5. Gestione Modelli

### 5.1 Decisione: modello singolo (cascata scartata)

Il design originale prevedeva una cascata: FunctionGemma 270M come classificatore veloce (Layer 1) davanti a Qwen3 4B (Layer 2). **La Fase 0 l'ha resa superflua** (ADR-007): Qwen3 4B da solo raggiunge 97.8% di tool accuracy e 98.9% di JSON validity sul benchmark bilingue — il routing non è il collo di bottiglia, e un secondo modello avrebbe aggiunto RAM, complessità e un punto di fallimento senza guadagno misurabile.

**Configurazione corrente**: un solo modello chat (default consigliato: Qwen3 4B Instruct 2507, Q4_K_M) + il modello embedding (nomic-embed, ~90 MB) in un secondo contesto. Il catalogo in-app è RAM-aware (1.7B per device low-RAM, 8B per flagship 12GB+).

### 5.2 Performance tuning (Fase 4)

Tre leve utente in Settings (`lib/llm/perf-config.ts`), tutte OFF di default:
- **CPU threads** — override del default di llama.rn;
- **KV cache q8_0 + flash attention** — dimezza la RAM della KV cache (misurato: 146 MB vs ~283 MB f16 a pari stato) al costo di ~1.5x in velocità su CPU; utile per contesti lunghi su device RAM-limitati;
- **mlock** — impedisce lo swap del modello.

Un cambio di perf settings invalida per design la session cache (le celle KV sono salvate tipizzate).

---

## 6. Comunicazione Mac Hub — ⏸️ PARCHEGGIATO

> **Re-scope Android-first (giugno 2026, ADR-010):** il Mac Hub non è mai stato
> costruito (`apps/mac-hub` non esiste). Il design qui sotto resta come riferimento
> per una eventuale ripresa; nessuna parte dell'app dipende da esso.

### 6.1 Discovery (design)

Il Mac Hub annuncerebbe la propria presenza via mDNS (Bonjour): service type `_vesta._tcp`, porta 8420, TXT record con versione e modelli disponibili. L'app farebbe scan periodico sulla LAN e si connetterebbe automaticamente.

### 6.2 Protocollo WebSocket (design)

Messaggi client→server: `CHAT`, `EMBED`, `UPLOAD`, `PING`. Server→client: `STREAM_START/CHUNK/END`, `EMBED_RESULT`, `UPLOAD_ACK`, `PONG`, `ERROR`. Spec completa in SPEC.md §7.

### 6.3 Fallback trasparente (design)

Hub connesso → delega dei task pesanti al modello 70B; Hub assente → tutto locale. Switch trasparente, indicatore discreto nella UI.

---

## 7. Decisioni Architetturali (ADR)

### ADR-001: llama.cpp come unico runtime di inferenza

**Contesto**: servono inferenza testo, function calling, e embedding su mobile.

**Decisione**: usare llama.cpp per tutti e tre i task.

**Alternative considerate**: MLC LLM (richiede ricompilazione per modello), ONNX Runtime (aggiunge secondo runtime), ExecuTorch (Meta-specifico, meno maturo).

**Motivazione**: llama.cpp supporta qualsiasi modello GGUF senza ricompilazione, ha il supporto embedding nativo, e la community più grande. Un solo runtime = meno bug, meno dimensione APK, meno manutenzione.

**Stato**: confermata. Implementata via llama.rn (vedi ADR-006).

### ADR-002: React Native invece di Kotlin nativo

**Contesto**: lo sviluppatore principale ha background TypeScript, non Kotlin.

**Decisione**: React Native + Expo per la maggior parte dell'app. Kotlin solo per i moduli nativi.

**Motivazione**: riduce il tempo di sviluppo del 60-70%. Il 90%+ della logica (orchestrator, prompt builder, RAG, storage, UI) è TypeScript cross-platform.

**Stato**: confermata. Il Kotlin effettivo è ancora meno del previsto: SystemActions, VestaService, widget e voice activity — il bridge llama.cpp è llama.rn, non codice nostro.

### ADR-003: sqlite-vec invece di ChromaDB/ObjectBox — ⚠️ SUPERATA da ADR-008

**Contesto**: serve un vector store per RAG su mobile.

**Decisione (marzo 2026)**: sqlite-vec (estensione C per SQLite).

**Esito**: mai implementata — expo-sqlite non può caricare estensioni native. Vedi ADR-008.

### ADR-004: Foreground Service con model lifecycle management — ✏️ EMENDATA da ADR-015

**Contesto**: Android uccide i processi in background dopo pochi minuti. Ricaricare un modello 4B richiede secondi (e senza session cache, decine di secondi di prefill).

**Decisione (marzo 2026)**: Foreground Service con notifica persistente; scaricamento del modello dopo 5 minuti di inattività.

**Esito**: il Foreground Service c'è; lo scaricamento automatico NO — vedi ADR-015.

### ADR-005: Model validation prima di architettura (Fase 0)

**Contesto**: l'intera app dipende dalla capacità di un modello 3-4B di capire comandi in italiano e generare JSON strutturato.

**Decisione**: dedicare la prima settimana interamente al testing dei modelli. Nessun codice Android scritto prima di avere dati concreti.

**Motivazione**: se il modello non funziona, nessuna architettura ti salva.

**Stato**: confermata — e ripagata: il benchmark di Fase 0 è rimasto il gate di regressione di ogni cambio di prompt (ri-eseguito per V3 e V4 in Fase 4).

### ADR-006: llama.rn come binding, non un bridge NDK in casa

**Contesto**: ADR-001 sceglie llama.cpp; serve esporlo a React Native.

**Decisione (Fase 1)**: usare llama.rn (binding RN mantenuto dalla community, JSI, streaming, saveSession/loadSession) invece di scrivere un modulo Kotlin+JNI proprio.

**Motivazione**: centinaia di righe di JNI evitate, aggiornamenti llama.cpp gratis, API completion/embedding/session già pronte. Costo: si dipende dalle scelte di release di un terzo (accettato; versione pinnata).

### ADR-007: Modello singolo — cascata FunctionGemma scartata

**Contesto**: il design originale prevedeva un classificatore 270M davanti al modello 4B (§5).

**Decisione (Fase 0, marzo 2026)**: un solo modello fa routing E generazione.

**Motivazione**: Qwen3 4B da solo: 97.8% tool accuracy / 98.9% JSON su 100 prompt bilingui. La cascata avrebbe aggiunto ~0.2 GB RAM, un secondo punto di fallimento e latenza di orchestrazione per risolvere un problema che non esiste. I dati decidono.

### ADR-008: Retrieval brute-force in TypeScript (supera ADR-003)

**Contesto**: expo-sqlite non carica estensioni native → sqlite-vec impossibile senza abbandonare Expo o aggiungere un secondo driver SQLite.

**Decisione (Fase 3)**: embedding come BLOB float32 in SQLite; cosine similarity brute-force in TS al momento della query; soglia di rilevanza 0.28.

**Motivazione**: a scala telefono (migliaia di chunk) la scansione lineare costa millisecondi — irrilevante rispetto ai secondi dell'inferenza. Zero dipendenze native aggiunte, zero secondo database. Verificata su device (PDF reale, airplane mode). Se un giorno i corpora crescessero di ordini di grandezza, un indice ANN diventa un upgrade interno a `document-retriever.ts`.

### ADR-009: Reminder via expo-notifications, non calendario

**Contesto**: `set_reminder` era inizialmente un insert calendario.

**Decisione (Fase 1)**: notifica locale schedulata (`expo-notifications`, trigger DATE, AlarmManager sotto il cofano).

**Motivazione**: un reminder è una notifica, non un evento: niente permessi calendario per lo use case, funziona offline, e il risultato è onesto (la notifica È il reminder; un insert calendario non garantisce alcun avviso).

### ADR-010: Re-scope Android-first — Mac Hub e iOS parcheggiati

**Contesto**: la roadmap originale aveva Fase 4 = Mac Hub, Fase 5 = iOS.

**Decisione (giugno 2026)**: fermare entrambi; la nuova Fase 4 è la performance on-device. Un solo device fatto bene batte tre piattaforme mediocri.

**Motivazione**: il valore differenziante di Vesta è l'esperienza offline sul telefono; l'hub è un boost opzionale per definizione (principio 3), e iOS raddoppia la superficie nativa prima che il prodotto sia solido.

### ADR-011: Prompt V4 — system prompt statico + contesto temporale per-turno

**Contesto**: llama.rn riusa la KV cache sul prefisso comune (ADR-006); qualunque byte volatile nel system prompt invalida tutto ciò che segue. Il layout V2 metteva la data PRIMA dei tool schema (~17s di re-prefill a ogni cambio di minuto); il layout V3 (prefisso stabile + coda data) lasciava comunque la history dopo la coda volatile (re-prefill crescente 5→12s).

**Decisione (Fase 4, PR #22)**: system prompt completamente statico; la data viaggia in una riga `[Contesto temporale: ...]` prepesa a OGNI messaggio utente, renderizzata dal `createdAt` salvato del messaggio (funzione pura → history byte-identica per sempre).

**Motivazione (misurata)**: ogni turno diventa un puro append KV — turni warm piatti ~6s contro i ~67s del V2, anche con prompt più GRANDI (+90 token/turno di annotazioni). Nessuna regressione di accuratezza (Fase 0: 98.9%/100%). Due invarianti bloccate dai test: niente valori per-turno nel system prompt; history = funzione pura dei messaggi salvati.

### ADR-012: Prefix session cache persistente (solo cold start)

**Contesto**: la KV reuse in-memory muore al riavvio dell'app: il primo messaggio pagava ~37s di prefill del prefisso stabile.

**Decisione (Fase 4, PR #20)**: salvare lo stato KV del prefisso su disco (`saveSession`) dopo il primo turno pulito e ripristinarlo (`loadSession`) subito dopo ogni load del modello, prima di qualsiasi completion.

**Motivazione (misurata)**: primo messaggio 37.3s → 2.8s (13.4x). Costi accettati e mitigati: llama.cpp serializza lo stato KV COMPLETO (~215 MB) → un solo file, salvataggi debounced 120s e saltati a hash valido; chiave = hash(model + kv-type + prefisso) così ogni cambiamento invalida; contenuto ripristinato validato contro il testo del prefisso (un file avvelenato si auto-ripara con un cold start).

### ADR-013: Estrazione memorie accodata alla conversazione

**Contesto**: l'estrazione memorie girava come prompt standalone sul contesto condiviso → evicteva la KV cache della chat e il turno successivo ripagava ~17s di prefill.

**Decisione (Fase 4, PR #18)**: l'estrazione appende `[assistant(risposta), user(istruzione)]` alla lista messaggi della chat — prefix-shared per costruzione, diventa un append economico. Guardie: skip se i token stimati sfiorerebbero il context shift; timeout disarmato appena la generate ritorna.

### ADR-014: Perf settings opt-in, default OFF

**Contesto**: q8_0 KV + flash attention dimezzano la RAM della KV cache, ma su inferenza CPU-only costano ~1.5x in velocità (misurato back-to-back a pari stato termico).

**Decisione (Fase 4, PR #17)**: le tre leve (threads, KV quant, mlock) sono esposte in Settings con default OFF e un hint che dichiara il trade-off. Un cambio di settings invalida la session cache per design.

**Motivazione**: il default deve essere il caso comune (velocità); la leva RAM serve a chi vuole contesti lunghi su device limitati — è una scelta informata dell'utente, non nostra.

### ADR-015: Nessun auto-unload del modello (emenda ADR-004)

**Contesto**: ADR-004 prevedeva lo scaricamento del modello dopo 5 minuti di inattività.

**Decisione (implementazione Fase 1, confermata in Fase 4)**: il modello chat resta residente finché il Foreground Service vive. Solo il contesto di embedding viene rilasciato al background dell'app.

**Motivazione**: lo scaricamento farebbe pagare a ogni ripresa il costo di load + re-prefill; la session cache (ADR-012) riduce il danno del cold start ma 2.8s ≠ 0. Il costo RAM del modello residente è il prezzo dichiarato del prodotto (catalogo RAM-aware). Il comportamento sotto memory pressure di sistema è ora gestito da ADR-016.

### ADR-016: Memory pressure — rilascia solo il contesto embedding, tieni il modello chat

**Contesto (Fase 5)**: ADR-015 tiene il modello chat residente, ma non gestiva la memory pressure di sistema. Su Android RN 0.83 l'evento `memoryWarning` di AppState NON scatta (l'`AppStateModule` lo emette solo su iOS): serve un hook nativo.

**Decisione**: `SystemActionsModule` registra un `ComponentCallbacks2` e su `onTrimMemory(level ≥ TRIM_MEMORY_RUNNING_LOW)` emette un device event `memoryWarning` a JS (guardato da `hasActiveReactInstance()`, come l'`AppStateModule` di RN). Il layout JS rilascia SOLO il contesto di embedding (`unloadEmbeddingModel`, idempotente, ~1s a ricaricare); il modello chat resta residente.

**Motivazione**: l'embedding è l'unica risorsa davvero cheap-to-rebuild. Il modello chat vale il costo di tenerlo; se la pressione è tale che l'OS ci uccide comunque, il Foreground Service è START_STICKY e la prefix session cache (ADR-012) rende la ripartenza ~3s. La session cache su disco NON va toccata sotto pressione: non ha lavoro pendente cancellabile (il debounce è un gate su `Date.now()`, non un timer) e cancellarla eliminerebbe proprio ciò che rende economico il restart.

### ADR-017: Il server MCP ascolta su loopback; la LAN è un opt-in a parte

**Contesto (Fase 6, slice 1)**: il trasporto nativo NanoHTTPD apriva `0.0.0.0`. Il server è spento di default e ogni richiesta passa da un bearer token, ma il trasporto è HTTP in chiaro e i tre tool esposti restituiscono calendario, numeri di telefono e passaggi dei documenti: su una Wi-Fi qualsiasi (hotel, ufficio, coinquilini) significa token e dati privati in chiaro, raggiungibili da qualunque host della rete.

**Decisione**: `McpServerModule.startServer(port, bindLan)` lega `127.0.0.1` salvo opt-in esplicito. La LAN è un secondo interruttore (`mcp_bind_lan`, di default off) con una conferma che dice cosa comporta. Cambiare binding a server acceso chiude il socket e rilega. Dal laptop, il caso loopback si raggiunge con `adb reverse tcp:8420 tcp:8420` (il comando di pairing lo mostra).

**Motivazione**: il valore di slice 1 — un agente sul computer dell'utente che chiede dati a Vesta — non richiede la LAN. Chi la vuole la accende sapendo cosa accende, invece di scoprirlo. Finché non c'è TLS, "rete domestica fidata" è il limite dichiarato.

### ADR-018: I GGUF scaricati si verificano con SHA-256, non con la dimensione

**Contesto (Fase 6)**: il downloader confrontava solo i byte totali (con 1 KB di tolleranza, e solo quando la dimensione era autorevole), poi rinominava il file nella directory dei modelli, dove llama.cpp lo mmappa come pesi. Un file sostituito, troncato-e-ripadded o ripreso male passava. L'oid LFS di HuggingFace — che è proprio lo sha256 — arrivava fino alla riga del DB e non veniva mai usato.

**Decisione**: prima del rename, il file temporaneo viene digerito e confrontato con l'oid atteso. Il digest è nativo (`SystemActionsModule.sha256File`, streaming a blocchi da 1 MB su un thread dedicato): un file da più GB non può attraversare il bridge né bloccare il thread dei moduli nativi.

La verifica **fallisce chiusa**: quando un digest atteso esiste, il commit avviene SOLO se combacia. Mismatch, hashing che solleva un errore e hashing non disponibile sulla build finiscono tutti e tre in quarantena (`<final>.corrupt`) con un errore chiaro — mai rinominato, e mai lasciato sul path temporaneo dove una resume ci appenderebbe sopra. "Upstream ha pubblicato un digest e non siamo riusciti a confermarlo" non è un warning: da qui è indistinguibile da un file sostituito. È invece diverso da "non esiste un digest autorevole" (repo senza oid): quello committa e viene dichiarato non verificato, perché non c'è niente contro cui controllare.

**Livelli di fiducia** (colonna `models.trust`, migrazione v4) — tre affermazioni diverse che non vanno appiattite:
`verified_upstream` (combacia col digest pubblicato dal repo), `verified_user_checksum` (combacia con un digest fornito dall'utente all'import), `user_supplied_baseline` (nessun digest esterno: hashato AL MOMENTO dell'import e conservato, così un cambiamento successivo è rilevabile — non dice nulla sulla provenienza), `unverified` (nessun digest: hashing non disponibile, o riga precedente alla colonna).

**Import locali**: un `.gguf` scelto dall'utente — scaricato altrove, mergiato o quantizzato a mano — resta di prima classe: niente repo HuggingFace, niente nome di file del catalogo, si passa dal file picker di sistema (SAF) come prima. L'URI scelto viene usato UNA volta, come sorgente di copia: i byte finiscono nella directory app-private dei modelli e tutto il resto (header check, hash, llama.cpp, ogni load successivo) legge quella copia, che nessun'altra app può riscrivere. Un import non scrive mai sopra un file già presente — due modelli diversi possono chiamarsi `model.gguf`, e adottare i byte già lì importerebbe il file sbagliato — quindi si prende un nome libero (`model-2.gguf`). Un checksum è opzionale (incollato, o letto da un `.sha256` adiacente quando l'URI è `file://`); se c'è, la verifica è obbligatoria e fallisce chiusa come sopra; se non c'è l'import procede — scegliere il file È la decisione di fiducia — e si registra comunque la baseline. La baseline viene poi usata: `activate()` rifiuta di caricare un modello la cui dimensione non corrisponde più a quella registrata (controllo cheap, a ogni load), e un'azione **Verify** ri-hasha su richiesta (esatta, manuale: hashare più GB non sta in un cold start).

**Motivazione**: la dimensione non dice niente sul contenuto, e il contenuto qui viene eseguito come pesi del modello. Il controllo di cancellazione resta DOPO l'hash, così un cancel durante il digest (che è lungo) vince comunque sul commit. Prima di passare il path a llama.cpp c'è un controllo strutturale a basso costo (magic GGUF, versione leggibile da llama.cpp, conteggi plausibili, file troncato): è early rejection con un messaggio sensato, NON un confine di sicurezza — parsare file di modello arbitrari resta rischioso.

### ADR-019: Lo scheduling si risolve in modo deterministico, prima del modello

**Contesto (hardening Android)**: timer, sveglie, promemoria ed eventi sono i comandi che armano stato reale del dispositivo, e sono anche quelli che la dettatura maltratta di più (esitazioni, ripetizioni, correzioni a metà frase). Farli passare da un 4B campionato rendeva il percorso più rischioso anche il meno prevedibile.

**Decisione**: `lib/scheduling` normalizza la trascrizione (via i filler, collassa le ripetizioni, spezza sulle marche di correzione) e legge i valori dall'ULTIMO segmento che li dichiara, così una correzione vince mentre un qualificatore non ripetuto (tipicamente il giorno) resta. Se è sicuro produce un intent strutturato — `timer(durationSeconds, label?)`, `timerWithWarning(durationSeconds, warningSeconds)`, `alarm(time, date?, label?)`, `reminder(dateTime, text)`, `calendarEvent(start, title)` — che `intent-to-tool.ts` mappa sulle chiamate ai tool ESISTENTI; se non è sicuro chiede; se non riconosce un comando di scheduling restituisce `none` e la strada resta quella del modello, invariata.

**Timer + avviso** ("quarantacinque minuti, ma avvisami cinque prima") è UNA richiesta in due parti, non due richieste: si risolve in due `set_timer` (l'avviso prima), perché l'intent Android accetta una durata sola. La quantità dell'avviso è quella che SEGUE la frase-marcatore, e solo se non c'è niente dopo si prende quella prima ("con un avviso di cinque minuti"). "cinque PRIMA" si sottrae dalla fine, "un avviso A quaranta" è già la lunghezza dell'avviso. Servono esattamente due durate: una sola ("dammi un avviso prima dei quarantacinque minuti") o nessuna ("avvisami prima del timer") chiedono.

**Eredità dell'unità**: un'unità esplicita vince sempre. Un numero nudo nell'avviso eredita PRIMA l'unità del timer — "give me two hours, warn me at one" è un'ora, non un minuto, e leggerlo in minuti è la risposta pericolosa perché suona 119 minuti in anticipo. I minuti restano il ripiego quando l'unità ereditata dà qualcosa di impossibile ("two hours, warn me at ninety" → 90 minuti, visto che 90 ore non ci stanno) e quando nessuna delle due quantità ha detto un'unità ("timer for forty five, warning at forty"). Se nessuna lettura sta in piedi, si chiede.

**Ora nuda — la regola, in ordine**: (1) am/pm esplicito o lettura 24h si prendono come dette; (2) una parola di parte-del-giorno decide ("di mattina" → am, "stasera"/"di notte" → pm); (3) un'espressione di risveglio ("wake me", e in italiano "sveglia", che è insieme sostantivo e verbo) significa mattina; (4) un "dodici" nudo è davvero a due vie — mezzogiorno e mezzanotte — e CHIEDE; (5) un giorno futuro nominato ("domani", "venerdì") con un'ora nuda 1-12 **CHIEDE**: nella frase non c'è niente che dica quale metà della giornata, e a differenza della (6) non c'è nemmeno l'orologio a cui appoggiarsi — "domani alle quattro" è testa o croce tra colazione e merenda, e una sveglia che sbaglia di dodici ore è peggio di una domanda in più; (6) altrimenti (nessun giorno, oppure "oggi") **la prossima occorrenza plausibile**: delle due letture (h e h+12) vince quella che arriva prima da adesso, scavallando a domani se sono passate entrambe. La (6) è il motivo per cui "sveglia alle quattro" sono le 04:00 se detto alle 02:00 e le 16:00 se detto alle 13:00; è deterministica (stessa coppia frase-istante, stessa risposta) e attraversa la mezzanotte da sola. La domanda della (4) e della (5) nomina l'ora di cui parla ("4 AM or 4 PM?"), così l'utente vede anche cosa è stato capito.

**Motivazione**: determinismo dove sbagliare costa di più, e latenza zero sul comando più frequente. L'esecuzione non cambia — stesso dispatcher, stesso confirm gate, stessi Intent Android — quindi il parser decide gli argomenti, mai l'esecuzione. Effetto collaterale utile: lo scheduling funziona anche mentre un modello si scarica o non è riuscito a caricarsi.

### ADR-020: Assistente di sistema via ACTION_ASSIST, non VoiceInteractionService

**Contesto**: l'APK installato non compariva in Impostazioni → App predefinite → App di assistenza digitale. Il role controller di Android cerca esattamente due cose per candidare un pacchetto a `ROLE_ASSISTANT`: un servizio che risponda a `android.service.voice.VoiceInteractionService`, oppure un'activity che gestisca `android.intent.action.ASSIST`. Vesta non dichiarava né l'uno né l'altra — `VestaVoiceActivity` non aveva alcun intent filter ed era `exported="false"`, raggiungibile solo dal PendingIntent del widget — quindi entrambe le query di sistema restituivano zero risultati.

**Decisione**: `VestaVoiceActivity` diventa anche il punto di ingresso dell'assistente, con un intent filter `ASSIST` + `VOICE_COMMAND` e `CATEGORY_DEFAULT`, esportata. Niente `VoiceInteractionService`.

**Motivazione**: un `VoiceInteractionService` deve dichiarare nei metadata un `android:recognitionService`, e quando l'assistente viene selezionato la piattaforma punta `Settings.Secure.VOICE_RECOGNITION_SERVICE` su quello. Vesta un riconoscitore non ce l'ha per scelta — delega a quello di sistema, tipicamente FUTO (vedi §8.3) — quindi non avrebbe niente di onesto da dichiarare lì, e dichiarare un no-op rischierebbe di togliere la dettatura alle altre app. In più il servizio resterebbe sempre legato dal sistema, mentre qui l'invocazione è solo esplicita: nessun hotword, nessuna cattura in background, niente microfono aperto fuori dal riconoscitore che l'utente ha invocato.

**Costo accettato**: niente assist context (screenshot/gerarchia delle view — non ci serve), niente invocazione da lockscreen, e su alcune shell OEM un tasto assistente hardware potrebbe onorare solo un `VoiceInteractionService`. Se dovesse servire, la strada è aggiungere il servizio E un `RecognitionService` che deleghi davvero — non prima.

**Percorso**: gesto assistente → `VestaVoiceActivity` (trasparente, nessuna UI di chat) → riconoscitore di sistema → trascrizione → `VestaAssistBridge` (statico in-process: la deep link `vesta://` è BROWSABLE e quindi falsificabile, e una richiesta dell'assistente viene ESEGUITA, non pre-riempita) → `consumeAssistRequest()` da JS → `processMessage`, il cui fast path deterministico gira prima di ogni controllo sul modello → Intent Android. `chat-store.init({ loadModel: false })` fa sì che un avvio da assistente non carichi il GGUF né avvii il foreground service: "timer di 30 secondi" arriva all'orologio senza che i pesi tocchino la RAM. Il modello si carica solo se l'utente chiede esplicitamente il fallback, cioè quando il parser ha già dichiarato che non era un comando di scheduling.

### ADR-021: Due backend sotto un'unica astrazione; NPU Qualcomm via Genie/GenieX (non ancora implementato)

**Contesto**: su un OnePlus 15 (Snapdragon 8 Elite Gen 5, SM8850) Qwen3 1.7B impiega 20-30s a caricarsi sul percorso llama.cpp attuale, che è CPU-bound. L'NPU Hexagon di quel SoC esiste apposta per questo carico. Ma i due mondi non sono intercambiabili: un `.gguf` gira ovunque, un context binary QNN è compilato per UNA famiglia di SoC e altrove non è "più lento", è inutilizzabile.

**Decisione (architettura)**: `lib/llm/backends` introduce `ModelBackend` — `supports()`, `load()`, `generate()`, `unload()`, `getDiagnostics()` — con `LlamaCppBackend` (adattatore sottile su `llm-engine`, che resta l'implementazione) e un `QualcommNpuBackend` **dichiarato e non implementato**. Il registry sceglie il primo backend che rivendica il modello, con llama.cpp in fondo: qualunque cosa nessuno rivendichi finisce sull'unico runtime che gira sempre. Lo stub riporta `available: false` e non rivendica niente — uno stub che fingesse trasformerebbe un fallback pulito in un load fallito, cioè esattamente ciò che questa astrazione esiste per evitare. GGUF, modelli importati dall'utente e il modello di trust restano intoccati.

**Decisione (backend NPU, da verificare in un pass dedicato)**: la strada consigliata è **Qualcomm Genie / GenieX**, non ExecuTorch e non il backend Hexagon di llama.cpp.
- *Genie/GenieX*: la documentazione Qualcomm elenca esplicitamente `Snapdragon 8 Elite Gen 5` (SM8850) tra le piattaforme Android validate, usa **Qwen3-4B come esempio principale** del tutorial, e GenieX espone un **SDK Android in Kotlin su Maven Central** — cioè un percorso di integrazione pensato per un'app di terze parti, non un runner da riga di comando. Requisiti dichiarati: Android 15+, Hexagon v73+, QAIRT 2.29+, 12 GB di RAM per modelli 3B+.
- *ExecuTorch QNN*: la pagina backend verifica SM8550/SM8450 e non elenca SM8850; richiede host Linux (Ubuntu 22.04), QNN SDK 2.37, NDK 26c, g++ 13, export AOT off-device in `.pte` e la ridistribuzione delle `.so` QNN con `LD_LIBRARY_PATH`/`ADSP_LIBRARY_PATH` da gestire a mano. Più pezzi mobili per lo stesso risultato.
- *llama.cpp Hexagon*: è marcato **experimental** a monte e c'è una issue aperta su output corrotto proprio su SM8850 / Hexagon v81, oltre al limite di 3.5 GB di spazio di indirizzamento per sessione NPU. Sarebbe la strada più elegante (stesso runtime, stesso formato) e va ricontrollata più avanti, ma oggi non è una base su cui costruire.

**Conseguenze**: il percorso NPU è per forza *curato*, non "porta il tuo GGUF": artefatti per-SoC (context binary + tokenizer + `genie_config.json`), esportati off-device via AI Hub. Perciò i due backend convivono invece di sostituirsi — llama.cpp resta l'unico che accetta un file arbitrario dell'utente. Da verificare prima di scrivere codice: i termini di ridistribuzione delle librerie runtime QAIRT/GenieX in un'app di terze parti, che la documentazione pubblica consultata non dichiara.

### ADR-022: Backend NPU Qualcomm via GenieX — gate di licenza superato, binari fuori dal repo

**Contesto**: ADR-021 aveva indicato Genie/GenieX come strada consigliata lasciando aperta *la* domanda che conta davvero: si può ridistribuire il runtime Qualcomm dentro un'app di terze parti, per giunta open source? Senza quella risposta il codice non si scrive.

**Verifica (fonti primarie, non memoria)**: `com.qualcomm.qti:qnn-runtime` su Maven Central dichiara la *Qualcomm AI Hub Model License*. Il §1(iv) concede di **"distribute and sublicense the Software solely in object code format and as incorporated in Your software application"**, e aggiunge che nulla autorizza a distribuirlo **"on a standalone basis"**. Il §9 precisa che il Software **"is NOT A CONTRIBUTION to any open source project"**. Gli asset generati da AI Hub seguono la licenza del modello di partenza (Qwen3 è Apache-2.0); serve un account gratuito Qualcomm. `com.qualcomm.qti:geniex-android` dichiara BSD-3-Clause più i Terms of Use Qualcomm.

**Decisione**: si procede, con un confine netto. Vesta resta MIT; i binari Qualcomm non entrano MAI nel repository — li risolve Gradle da Maven in fase di build, così finiscono nell'APK (permesso) e non nella storia git (non permesso, e incompatibile con una licenza MIT). Le note proprietarie dell'AAR vanno preservate (§2b). Il backend è **opt-in di build** (`VESTA_ENABLE_NPU=1`), nella stessa forma del profilo scheduling-only e della firma release: senza il flag non esiste né la dipendenza né il bridge nativo, quindi una build normale non può rompersi su un SDK che non ha scaricato.

**Runtime scelto: GenieX** (`com.qualcomm.qti:geniex-android`). Ha un SDK Kotlin su Maven pensato per app di terze parti, elenca esplicitamente Snapdragon 8 Elite Gen 5 (SM8850), e la sua API espone esattamente ciò che serve qui: generazione in streaming, `stopStream` per la cancellazione, e `applyChatTemplate(..., enableThinking)` che mappa uno-a-uno sulla soppressione del reasoning della modalità assistente. ExecuTorch QNN non elenca SM8850 e vuole export AOT su host Linux; il backend Hexagon di llama.cpp resta sperimentale con una issue aperta di output corrotto proprio su SM8850/v81.

**Formato artefatto**: bundle AI Hub precompilato, quantizzazione **w4a16** (pesi int4, attivazioni int16), compilato per UNA famiglia di SoC. Non è portabile: su un chip diverso non è più lento, è inservibile — perciò un modello NPU porta il SoC di destinazione nei metadati e viene rifiutato altrove. GenieX accetta anche GGUF (con `Q4_0` per finire sull'NPU), ma il "porta il tuo GGUF qualunque" resta lavoro di llama.cpp, su qualsiasi dispositivo.

**Conseguenza**: i due backend convivono per costruzione. Il dettaglio operativo sta in `docs/NPU-BACKEND.md`.

---

## 8. Sicurezza

### 8.1 Threat Model

- **Superficie di rete (due sole direzioni, entrambe avviate dall'utente)**:
  - *In uscita*: `lib/models/hf-client.ts` verso `huggingface.co` (elenco dei
    `.gguf` di un repo e download del file, che redirige sulla CDN di HF). È
    l'UNICA `fetch()` dell'app. Nessuna telemetria, nessuna analytics, nessun
    crash reporting, nessuna inferenza cloud — e nessun SDK che possa
    aggiungerli. Il file scaricato viene verificato con SHA-256 contro l'oid LFS
    pubblicato da HF **prima** di essere promosso a modello utilizzabile (vedi
    ADR-018); un mismatch va in quarantena e il download fallisce.
  - *In ingresso*: il server MCP opzionale (Fase 6), **spento di default** e,
    quando acceso, in ascolto su **127.0.0.1**. L'esposizione in LAN è un
    secondo opt-in esplicito e confermato: è HTTP in chiaro, quindi il bearer
    token e i dati (calendario, contatti, estratti dei documenti) attraversano
    il Wi-Fi in chiaro. Token per-client, revocabili all'istante. Niente TLS.
- **Accesso fisico al device**: conversazioni e documenti sono sul device, nel sandbox dell'app. Encryption at rest del database: **non implementata** (il DB vive nella private app dir; FDE/FBE di Android è la mitigazione corrente). Candidata per una fase futura.
- **Prompt injection via documenti**: un PDF malizioso potrebbe contenere testo che manipola il modello. Mitigazione: i chunk sono iniettati come tool result con istruzione di rispondere SOLO sugli estratti; le azioni di sistema restano dietro il confirm gate.
- **Azioni non autorizzate**: il modello potrebbe hallucinate un'azione non richiesta. Mitigazione: step di conferma esplicito nella UI prima di ogni azione; `make_call`/`send_sms` sono sempre confermati e comunque non partono da soli (ACTION_DIAL/ACTION_SENDTO aprono l'app di sistema — l'utente preme l'ultimo bottone).

### 8.2 Permessi Android

Permessi effettivamente dichiarati (`apps/mobile/app.json`):

| Permesso | Motivo |
|---|---|
| `com.android.alarm.permission.SET_ALARM` | Sveglie e timer |
| `READ_CALENDAR` / `WRITE_CALENDAR` | Leggere e creare eventi |
| `READ_CONTACTS` | Cercare contatti per nome (NON serve allo scheduling — vedi sotto) |
| `POST_NOTIFICATIONS` | Reminder (notifiche locali) + notifica del Foreground Service |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` | Tenere il modello in memoria |
| `RECORD_AUDIO` | Input vocale dal widget (riconoscitore di sistema) |

Non sono in `app.json` ma finiscono comunque nel manifest generato, quindi vanno
contati:

| Permesso | Da dove arriva | Perché serve |
|---|---|---|
| `INTERNET` | manifest di `expo-file-system` + template Expo | Download dei modelli (unica uscita di rete) |
| `VIBRATE` | blocco "optional" del template Expo | Notifiche dei promemoria |
| `RECEIVE_BOOT_COMPLETED` | manifest di `expo-notifications` | Riarmare i promemoria dopo un riavvio |

**Permessi rimossi dal manifest** (`plugins/with-permission-profile.js`), perché
nessun percorso di codice li raggiunge: `SYSTEM_ALERT_WINDOW` (overlay, dal
blocco "optional" del template — widget e quick chat sono normali Activity),
`WRITE_CONTACTS` (aggiunto da `expo-contacts`; Vesta i contatti li legge
soltanto), `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` (storage legacy
dal template; documenti e modelli passano dallo Storage Access Framework e
vivono nella app-private dir). Il plugin li toglie sia dalla nostra
dichiarazione sia, con `tools:node="remove"`, da quelle che una libreria
potrebbe unire in fase di build.

**Build "solo scheduling"**: con `VESTA_SCHEDULING_ONLY=1 npx expo prebuild
--platform android --clean` viene tolto anche `READ_CONTACTS`. Le funzioni che
lo usano (`search_contacts`, `make_call`, `send_sms`) degradano in modo onesto —
il permesso risulta negato e i tool rispondono già "mi servono i permessi per
accedere ai contatti" — mentre timer, sveglie, promemoria ed eventi non toccano
la rubrica. Di default la build resta completa.

Permessi che il design originale prevedeva e che NON servono: `CALL_PHONE` e `SEND_SMS` (le azioni usano `ACTION_DIAL`/`ACTION_SENDTO`: aprono l'app di sistema precompilata, l'utente conferma lì); `ACCESS_NETWORK_STATE` (serviva al Mac Hub, parcheggiato). Nessun Accessibility Service, nessun accesso al registro chiamate, nessun permesso SMS.

### 8.3 Input vocale

L'input vocale passa dal riconoscitore **di sistema**
(`RecognizerIntent.ACTION_RECOGNIZE_SPEECH` in `VestaVoiceActivity`), sia dal
widget sia dal gesto dell'assistente di sistema (ADR-020), non da un
motore incluso nell'app: chiunque l'utente abbia impostato come riconoscitore
gestisce l'audio, quindi un motore offline come FUTO Voice Input funziona senza
modifiche e Vesta non spedisce né conserva audio. Non sostituire questo percorso
con un Whisper integrato: l'offline-first sta lì, e il riconoscitore di sistema è
già caldo quando l'utente tocca il microfono.

Il testo che ne esce è quello che una persona dice davvero — esitazioni,
ripetizioni, correzioni a metà frase — e per i comandi di scheduling viene
normalizzato e interpretato in modo deterministico in `lib/scheduling` (vedi
ADR-019) prima ancora di considerare il modello.
