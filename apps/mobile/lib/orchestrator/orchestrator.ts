// Orchestrator — the core brain of Vesta.
// Routes user messages through the LLM, parses tool calls, dispatches actions.
// Now includes memory retrieval (inject into prompt) and extraction (post-response).

import { generate, isLoaded } from "../llm/llm-engine";
import type { CompletionMessage } from "../llm/llm-engine";
import { buildStablePrefix, annotateUserMessage } from "./prompt-builder";
import { schedulePrefixPersist } from "./session-warmer";
import { parseResponse, stripThinkTags, looksLikeToolAttempt } from "./response-parser";
import type {
  Language,
  OrchestratorResponse,
  Message,
  ToolCallResult,
  ParsedToolCall,
} from "./types";
import { dispatchToolCall } from "./tool-dispatcher";
import type { Grounding } from "../scheduling/grounding";
import {
  getMemoriesForPrompt,
  extractMemories,
  shouldExtractMemory,
  cancelExtraction,
} from "./memory-manager";
import { getKnowledgeForPrompt } from "./knowledge-manager";
import { getConfig } from "../storage/database";
import { toolRequiresConfirmation, toolReturnsData } from "../tools/tool-registry";
import { parseSchedulingCommand } from "../scheduling/parse";
import { abandonmentMarker, abandonmentAcknowledgement } from "../scheduling/cancellation";
import { parserGrounding, apiGrounding } from "../scheduling/grounding";
import { answerIfTimeQuestion, deviceZone } from "../time/world-time";
import { intentToToolCalls, clarificationFor } from "../scheduling/intent-to-tool";

export interface ProcessOptions {
  assistMode?: boolean;
}

// Spoken answers are short by construction: a cap here is what stops the
// assistant reading out three paragraphs.
const ASSIST_MAX_TOKENS = 320;

const MAX_HISTORY_MESSAGES = 20;
// Once the conversation exceeds the window, `slice(-MAX)` would re-slice to a
// different set every turn — the replayed history's head would shift by one
// each turn and re-prefill the whole window (the V4 append win evaporates on
// long chats). Instead we pin the window START to a multiple of this stride, so
// it only advances in jumps: between jumps the head is byte-identical and the
// turn stays a pure KV append; only a boundary crossing pays one re-prefill
// (~once per stride messages instead of every turn). Cost: the window can hold
// up to MAX + STRIDE - 1 messages — still far under the context size.
const HISTORY_SLIDE_STRIDE = 8;

// The index of the first history message to include. Rounds the "last MAX"
// start DOWN to a stride boundary so it advances every STRIDE messages, not
// every turn. Exported for the byte-stability tests. Pure function of length.
export function historyWindowStart(total: number): number {
  const minStart = Math.max(0, total - MAX_HISTORY_MESSAGES);
  return Math.floor(minStart / HISTORY_SLIDE_STRIDE) * HISTORY_SLIDE_STRIDE;
}

// Runs a confirmed tool call. Called by the store after the user approves a
// pending (destructive) action; routing already validated the tool name.
export function executeToolCall(
  tool: string,
  parameters: Record<string, unknown>,
  lang: Language = "en",
  grounding?: Grounding,
): Promise<ToolCallResult> {
  // The caller knows where these values came from; without that this is an
  // unattributed dispatch and the guard refuses it. The assistant's confirm
  // button passes the utterance that produced the proposal.
  return dispatchToolCall(tool, parameters, lang, grounding ?? apiGrounding);
}

// Deterministic scheduling fast path. Timers, alarms, reminders and calendar
// events are the commands where a sampled model is most expensive to get wrong
// — they arm a real device alarm — and where the phrasing is most predictable.
// When the parser is confident, the tool call is built from the transcript
// itself: no generation, no temperature, identical output every time, and it
// works with no model loaded at all. Anything it isn't confident about returns
// null here and takes the normal LLM route, unchanged.
//
// The resolved call still goes through dispatchToolCall and the same
// confirmation gate as a model-routed one — this decides the arguments, never
// the execution.
async function tryDeterministicScheduling(
  userText: string,
  lang: Language,
  now: Date,
  confirmEnabled: boolean,
): Promise<OrchestratorResponse | null> {
  const parsed = parseSchedulingCommand(userText, { now, lang });

  if (parsed.status === "ambiguous") {
    // Recognized as scheduling but not safely resolvable — ask, don't guess.
    return {
      type: "text",
      content: clarificationFor(parsed.reason, lang, parsed.detail),
    };
  }
  if (parsed.status !== "resolved") return null;

  // Almost always one call; a timer with an earlier warning is two (Android
  // takes one duration per timer). The LAST call is the primary one and carries
  // the confirmation describing the whole request.
  const calls = intentToToolCalls(parsed.intent, now, lang);
  const primary = calls[calls.length - 1];

  if (toolRequiresConfirmation(primary.tool, confirmEnabled)) {
    // Confirm-gated tools are never compound — only timers are, and timers are
    // not gated — so handing the single proposed call to the UI is exact.
    return {
      type: "pending_tool_call",
      tool: primary.tool,
      parameters: primary.parameters,
      message: primary.message,
    };
  }

  // Run them in order (warning first, so a failure to set it surfaces before
  // the user is told both are set). Report the first failure if there is one:
  // claiming success for a pair where half of it didn't happen is worse than a
  // slightly noisier message.
  let failure: ToolCallResult | null = null;
  let last: ToolCallResult | null = null;
  const grounding = parserGrounding(userText, lang);
  for (const call of calls) {
    last = await dispatchToolCall(call.tool, call.parameters, lang, grounding);
    if (!last.success && !failure) failure = last;
  }

  return {
    type: "tool_call",
    tool: primary.tool,
    parameters: primary.parameters,
    message: primary.message,
    result: failure ?? last!,
  };
}

/**
 * What a deterministic layer produced, and whether it is the end of the turn.
 *
 * The distinction is the whole point of this type. A deterministic layer can
 * return prose for two completely different reasons — here is your answer, or
 * I need one more thing from you — and `OrchestratorResponse` renders both as
 * `{ type: "text" }`. The assistant surface has to tell them apart: an ANSWER
 * is a finished turn that speaks and gets out of the way, while a QUESTION
 * must keep the surface open with an Answer button and remember what to resume.
 *
 * Conflating the two is a bug this project has now shipped twice. The first
 * time, a chat answer was filed as a clarification and prepended to the next
 * invocation. The second time, "What time is it in Norway?" — a completed
 * deterministic answer — was filed the same way, so the NEXT invocation
 * ("What time is it in the United States?") was really asked as both questions
 * at once, inherited the previous turn's session, and ended up in the model and
 * then in the wrong chat. `resume` being present or absent is now the only
 * thing that decides, and it is set at the point that knows.
 */
export interface DeterministicResult {
  response: OrchestratorResponse;
  /**
   * Present ONLY when `response` is a question the user still owes an answer
   * to. Its value is the text a follow-up is appended to — the original
   * utterance for a scheduling clarification, or the world-time question with
   * the ambiguous place removed ("what time is it in" + "Chicago").
   */
  resume?: string;
}

/**
 * Everything Vesta can answer WITHOUT a model, in the order it is tried.
 *
 * Three layers, each of which either answers or steps aside:
 *
 *   1. abandonment — "…actually, cancel". A withdrawn request must not be
 *      acted on by anything downstream, so this runs before routing rather
 *      than inside it. Dictation has no backspace; see scheduling/cancellation.
 *   2. scheduling — timers, alarms, reminders, events. Resolves from the
 *      user's own tokens or asks; never invents a value.
 *   3. world time — "what time is it in Norway". The device has the IANA tz
 *      database; asking a 4B model to recall UTC offsets is how you get
 *      confident wrong answers, and it used to decline the question outright.
 *
 * Null means none of them applied and the utterance belongs to the model.
 */
export async function tryDeterministicAnswer(
  userText: string,
  lang: Language,
  now: Date,
  confirmEnabled: boolean,
): Promise<DeterministicResult | null> {
  const marker = abandonmentMarker(userText, lang);
  if (marker) {
    // Terminal. Nothing parses, nothing dispatches, no model is loaded — the
    // user has said to drop it, and the rest of the transcript is the request
    // they dropped. No resume: there is nothing left to finish.
    return { response: { type: "text", content: abandonmentAcknowledgement(lang) } };
  }

  const scheduled = await tryDeterministicScheduling(
    userText,
    lang,
    now,
    confirmEnabled,
  );
  if (scheduled) {
    // The parser's only prose is a clarification question, and a follow-up
    // completes the ORIGINAL utterance ("set an alarm tomorrow at four" + "pm").
    return scheduled.type === "text"
      ? { response: scheduled, resume: userText }
      : { response: scheduled };
  }

  const timeAnswer = answerIfTimeQuestion(userText, lang, now, deviceZone());
  if (timeAnswer) {
    if (timeAnswer.status === "resolved") {
      // A finished answer. Nothing is pending, and nothing may be carried into
      // the next invocation.
      return { response: { type: "text", content: timeAnswer.text } };
    }
    return {
      response: { type: "text", content: timeAnswer.question },
      // The question minus the ambiguous place, so "Chicago" completes it.
      // Absent for the forms that cannot be rewritten that way.
      resume: timeAnswer.resume,
    };
  }

  return null;
}

/**
 * The deterministic layers, and nothing else. Returns null when none applies.
 *
 * This exists because the assistant surface must be able to ask "is this a
 * timer?" without any chance of starting a generation. It used to ask by
 * calling processMessage and treating the "No model loaded" error as "not
 * scheduling" — which held only while no model was resident. Once one WAS
 * loaded (any warm process, which is the normal case), that same call ran a
 * full chat turn instead: the answer came back as `type: "text"`, which the
 * assistant reads as the parser's own clarification question. Everything
 * downstream then went wrong at once — the answer was shown unrendered, the
 * utterance was stored as a pending clarification and prepended to the NEXT
 * invocation, and that invocation inherited the previous turn's session. One
 * ambiguous return value, four bugs.
 *
 * There is no ambiguity here: a result means a deterministic layer handled it
 * (and `resume` says whether it finished or asked), null means none did. Model
 * involvement is the caller's decision.
 */
export async function processDeterministic(
  userText: string,
  lang: Language,
  sentAt: Date = new Date(),
): Promise<DeterministicResult | null> {
  let confirmEnabled = true;
  try {
    confirmEnabled = (await getConfig("confirm_destructive_actions")) !== "false";
  } catch (err) {
    console.warn("[Orchestrator] Failed to read the confirmation setting:", err);
  }
  return tryDeterministicAnswer(userText, lang, sentAt, confirmEnabled);
}

export async function processMessage(
  userText: string,
  history: Message[],
  lang: Language,
  onToken?: (token: string) => void,
  // Read/query tools generate twice (detect the tool, then answer from its
  // data). This clears the streamed tool-call JSON before the answer streams,
  // so the user sees a clean reply instead of "JSON…answer".
  onStreamReset?: () => void,
  // The instant this turn's time context renders from. Callers that persist
  // the message pass its createdAt so the live render and every future
  // history replay come from the SAME instant — byte-identical by
  // construction, which is the KV-cache invariant. Defaults to now.
  sentAt: Date = new Date(),
  // Assist mode: the system-assistant surface, which is spoken aloud and has
  // no room for thinking-out-loud. Turns OFF the model's reasoning pass at
  // generation time (the runtime's own switch, not a post-hoc strip) and keeps
  // the answer short. Ordinary chat passes nothing and is unchanged.
  options: ProcessOptions = {},
): Promise<OrchestratorResponse> {
  // The confirmation setting gates both routes below (default ON for safety).
  let confirmEnabled = true;
  try {
    confirmEnabled = (await getConfig("confirm_destructive_actions")) !== "false";
  } catch (err) {
    console.warn("[Orchestrator] Failed to read the confirmation setting:", err);
  }

  // The deterministic layers first — before the model-loaded check, so a
  // timer, an alarm or a world-clock question still works while a model is
  // downloading or failed to load, and an abandoned utterance stops here.
  const deterministic = await tryDeterministicAnswer(
    userText,
    lang,
    sentAt,
    confirmEnabled,
  );
  // Chat renders a question and an answer the same way, so it only needs the
  // response. The assistant surface needs `resume` as well — see the type.
  if (deterministic) return deterministic.response;

  if (!isLoaded()) {
    return { type: "error", error: "No model loaded" };
  }

  // Fetch relevant memories and knowledge files for context injection.
  let memoriesBlock: string | null = null;
  let knowledgeBlock: string | null = null;
  try {
    const [m, k] = await Promise.all([
      getMemoriesForPrompt(),
      getKnowledgeForPrompt(),
    ]);
    memoriesBlock = m;
    knowledgeBlock = k;
  } catch (err) {
    console.warn("[Orchestrator] Failed to fetch context:", err);
  }

  // The system prompt is fully STATIC (V4): the date lives in a per-turn
  // [Contesto temporale: ...] line on each user message instead of a volatile
  // tail. History turns render from their stored createdAt — a pure function,
  // so the replayed history is byte-identical across turns and the whole
  // conversation stays a growing KV-cache prefix.
  const stablePrefix = buildStablePrefix(lang, memoriesBlock, knowledgeBlock);

  // Build conversation messages for the LLM
  const messages: CompletionMessage[] = [
    { role: "system", content: stablePrefix },
  ];

  // Add recent history (anchored sliding window — see historyWindowStart).
  const recent = history.slice(historyWindowStart(history.length));
  for (const msg of recent) {
    if (msg.role === "user") {
      messages.push({
        role: "user",
        content: annotateUserMessage(lang, new Date(msg.createdAt), msg.content),
      });
    } else if (msg.role === "assistant") {
      let content = msg.content;
      // Append tool result so the LLM can see what happened in follow-up turns
      if (msg.toolCall && msg.toolResult) {
        try {
          const call = JSON.parse(msg.toolCall);
          const result = JSON.parse(msg.toolResult);
          const status = result.success ? "success" : "failed";
          content += `\n[Tool: ${call.tool} → ${status}${result.error ? ": " + result.error : ""}]`;
        } catch {
          // corrupted JSON — skip annotation
        }
      }
      messages.push({ role: "assistant", content });
    }
  }

  // Add current user message with this turn's time context.
  messages.push({
    role: "user",
    content: annotateUserMessage(lang, sentAt, userText),
  });

  try {
    // A background memory-extraction pass may still hold the engine lock.
    // Cancel it (it stops the native completion) so this user turn starts
    // immediately instead of waiting for the extraction to finish (ORCH-1).
    cancelExtraction();

    // Lower temperature than the engine default: this turn must emit clean
    // tool-call JSON, and near-deterministic sampling improves validity and
    // tool-selection consistency without hurting chat quality much (LLM-5).
    const result = await generate(
      messages,
      {
        maxTokens: options.assistMode ? ASSIST_MAX_TOKENS : 4096,
        temperature: 0.3,
        // The runtime's own switch (llama.rn `enable_thinking`), which stops a
        // reasoning model from producing the block at all rather than hiding it
        // afterwards. Left undefined for chat so the model's default stands.
        ...(options.assistMode ? { enableThinking: false } : {}),
      },
      onToken,
    );
    const raw = result.text;
    if (__DEV__) {
      console.log(
        `[Perf] promptMs=${Math.round(result.timings.promptMs)} predictedPerSecond=${result.timings.predictedPerSecond.toFixed(1)}`,
      );
    }

    // True when this turn ran more than the single first-pass generate (query
    // loop or malformed-JSON retry). Those paths append extra messages to the
    // KV state, so the session-cache persist guard's token estimate (built
    // from `messages` alone) would undercount — skip persisting those turns.
    let extraGenerationRan = false;

    // Handles a successfully-parsed tool call. Extracted so both the first-pass
    // parse and the malformed-JSON retry below reuse the same dispatch logic:
    // read/query tools run inline (the query loop), destructive tools are gated
    // for confirmation, everything else dispatches directly.
    const handleToolCall = async (
      call: ParsedToolCall,
      callRaw: string,
    ): Promise<Exclude<OrchestratorResponse, { type: "error" }>> => {
      if (toolReturnsData(call.tool)) {
        // Read/query tool: run it, then re-generate an answer grounded in the
        // returned data (a function-calling loop). Never gated — read-only.
        const toolResult = await dispatchToolCall(
          call.tool,
          call.parameters,
          lang,
          { source: "model", utterance: userText, lang },
        );
        if (!toolResult.success) {
          // e.g. permission denied or no data — surface the reason as text.
          return { type: "text", content: toolResult.message };
        }
        // Clear the streamed tool-call JSON, then stream the real answer.
        onStreamReset?.();
        extraGenerationRan = true;
        // Annotated like every user message: the RULES point date resolution
        // at the MOST RECENT user message's time context, and this synthetic
        // turn is now it. Never persisted, so no replay-stability concern.
        const followupMessages: CompletionMessage[] = [
          ...messages,
          { role: "assistant", content: callRaw },
          {
            role: "user",
            content: annotateUserMessage(
              lang,
              sentAt,
              lang === "it"
                ? `Risultato dello strumento ${call.tool}:\n${toolResult.data ?? "(nessun dato)"}\n\nRispondi alla mia richiesta precedente in italiano, in modo naturale e conciso, usando SOLO questi dati. Non mostrare JSON.`
                : `Result of tool ${call.tool}:\n${toolResult.data ?? "(no data)"}\n\nAnswer my previous request in English, naturally and concisely, using ONLY this data. Do not show JSON.`,
            ),
          },
        ];
        const followup = await generate(
          followupMessages,
          { maxTokens: 1024, temperature: 0.4 },
          onToken,
        );
        // Guard: if the model answered with a tool-call JSON instead of prose
        // (it shouldn't, but the system prompt still allows JSON), don't dump
        // raw JSON at the user — fall back to a plain message.
        const answer =
          parseResponse(followup.text) || looksLikeToolAttempt(followup.text)
            ? lang === "it"
              ? "Ho recuperato i dati ma non sono riuscito a formulare una risposta. Riprova."
              : "I fetched the data but couldn't phrase an answer. Please try again."
            : followup.text;
        return { type: "text", content: answer };
      }

      const confirmMessage = call.message || (lang === "it" ? "Fatto!" : "Done!");
      if (toolRequiresConfirmation(call.tool, confirmEnabled)) {
        // Don't touch the device yet — hand the proposed action to the UI for
        // explicit user confirmation. The store dispatches it via executeToolCall.
        return {
          type: "pending_tool_call",
          tool: call.tool,
          parameters: call.parameters,
          message: confirmMessage,
        };
      }
      // A model-produced call. `model` provenance means the temporal values
      // are checked against what the user actually said before anything is
      // armed — the guard that stops a required field being filled in with a
      // plausible time nobody asked for.
      const toolResult = await dispatchToolCall(call.tool, call.parameters, lang, {
        source: "model",
        utterance: userText,
        lang,
      });
      return {
        type: "tool_call",
        tool: call.tool,
        parameters: call.parameters,
        message: confirmMessage,
        result: toolResult,
      };
    };

    // Try to parse as tool call
    const toolCall = parseResponse(raw);

    let response: OrchestratorResponse;

    if (toolCall) {
      response = await handleToolCall(toolCall, raw);
    } else if (looksLikeToolAttempt(raw)) {
      // The model tried to emit a tool call but it didn't parse — malformed or
      // truncated. Per the Fase 2 exit gate, retry ONCE with a correction prompt
      // demanding valid JSON only; if it still fails, degrade gracefully instead
      // of dumping raw partial JSON at the user (ORCH-8).
      const truncatedHint =
        lang === "it"
          ? "Non sono riuscito a completare quell'azione (risposta troncata). Riprova, magari riformulando."
          : "I couldn't complete that action (the response was cut off). Please try again, perhaps rephrasing.";

      if (result.stoppedByUser) {
        // The user tapped Stop mid-stream — don't launch a fresh generation they
        // just asked to cancel; show the hint (matches the pre-retry behavior).
        response = { type: "text", content: truncatedHint };
      } else {
        onStreamReset?.();
        extraGenerationRan = true;
        const correction: CompletionMessage[] = [
          ...messages,
          // Cap the (possibly runaway/repetitive) bad output so it can't dominate
          // the retry context or re-seed the same degenerate pattern.
          { role: "assistant", content: raw.slice(0, 800) },
          {
            // Annotated: this retry may re-emit date-bearing tool JSON, and
            // the RULES point at the most recent user message's time context.
            role: "user",
            content: annotateUserMessage(
              lang,
              sentAt,
              lang === "it"
                ? "La tua risposta precedente non era un JSON valido. Rispondi di nuovo con SOLO l'oggetto JSON dello strumento, senza testo, senza spiegazioni e senza blocchi di codice."
                : "Your previous reply was not valid JSON. Reply again with ONLY the tool JSON object — no prose, no explanation, no code fence.",
            ),
          },
        ];
        // Silent correction pass (no onToken): don't stream a second raw-JSON
        // attempt at the user; the first streamed attempt was cleared above. A
        // tool-call JSON is short, so a tight token cap keeps the wait small.
        const retry = await generate(correction, {
          maxTokens: 512,
          temperature: 0.2,
        });
        if (retry.stoppedByUser) {
          response = { type: "text", content: truncatedHint };
        } else {
          const retryToolCall = parseResponse(retry.text);
          if (retryToolCall) {
            response = await handleToolCall(retryToolCall, retry.text);
          } else if (
            stripThinkTags(retry.text).trim() &&
            !looksLikeToolAttempt(retry.text)
          ) {
            // Retry produced usable prose — fall back to general chat.
            response = { type: "text", content: retry.text };
          } else {
            // Still a broken or empty tool attempt — show the clean hint.
            response = { type: "text", content: truncatedHint };
          }
        }
      }
    } else if (options.assistMode) {
      // Assist mode never shows reasoning. `content` is llama.rn's filtered
      // text; it is empty when the runtime didn't recognize the model's
      // reasoning format, so fall back to the raw text and let the caller
      // sanitize (see lib/assist/response-text).
      response = { type: "text", content: result.content || raw };
    } else {
      // Plain text response — keep think tags for styled UI rendering
      response = { type: "text", content: raw };
    }

    // Fire-and-forget: persist the stable prefix's KV state for the next cold
    // launch, if the on-disk cache is stale. Only after a clean single-generate
    // turn: a user Stop can interrupt prefill mid-prefix, and multi-generate
    // paths break the guard's token estimate (see extraGenerationRan). Must be
    // called BEFORE extractMemories: the persist path is synchronous up to its
    // engine-lock enqueue, so the snapshot enters the FIFO lock queue ahead of
    // the extraction generate and captures the just-finished turn's KV state.
    //
    // Assist mode is excluded deliberately. A spoken one-shot turn must leave
    // the stable prefix EXACTLY as it found it: the prefix is the session
    // cache's key, and an assistant turn that changed it would invalidate the
    // restored KV state and make the next invocation pay a full cold prefill.
    if (!result.stoppedByUser && !extraGenerationRan && !options.assistMode) {
      schedulePrefixPersist(stablePrefix, lang, messages, result.tokensPredicted);
    }

    // Fire-and-forget: extract memories from this exchange — but skip turns that
    // can't yield a useful fact (tool-call confirmations, greetings/acks). This
    // avoids a second full LLM pass that, because the engine serializes all
    // generation, would otherwise stall the user's next message (ORCH-1).
    // Pass this turn's message list: extraction appends its request to the chat
    // context so it reuses (and preserves) the cached prompt prefix instead of
    // evicting it with a standalone prompt — see extractMemories (REV-1).
    //
    // Assist mode never extracts. An assistant invocation is standalone by
    // construction, and memories are injected into the stable prefix of every
    // later turn — so mining a spoken one-shot answer would feed that answer
    // back into the NEXT invocation's system prompt (a question about dwarves
    // bleeding into "what time is it"), and change the prefix hash each time,
    // costing a full re-prefill on top. Things the user asks Vesta to remember
    // are still extracted from the chat screen, which is where a conversation
    // actually happens.
    const isToolTurn =
      response.type === "tool_call" || response.type === "pending_tool_call";
    if (!options.assistMode && shouldExtractMemory(userText, isToolTurn)) {
      const assistantContent =
        response.type === "text" ? stripThinkTags(response.content) : response.message;
      extractMemories(messages, assistantContent, "", lang).catch((err) => {
        console.warn("[Orchestrator] Memory extraction failed:", err);
      });
    }

    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { type: "error", error: message };
  }
}
