// Whether a model can be made the active chat/assistant model.
//
// ONE function, read by both the Models screen and model-store.activate(). They
// disagreed before: the screen decided whether to draw "Use this model" from
// `state === "ready"` while activate() applied that plus its own file checks,
// so a row could be un-selectable for a reason the UI never named. A user then
// has to guess, and the nearest visible difference — a trust label — looks like
// the cause when it isn't.
//
// Trust is deliberately NOT a gate here. An unverified model is labelled, not
// blocked: that is the policy everywhere else (a locally imported GGUF with no
// checksum is usable), and blocking on it in one place only would be a silent
// second policy.

import type { InstalledModel, ModelRole } from "./types";

export type ActivationRefusal =
  | "downloading"
  | "not-ready"
  | "wrong-role";

export type ActivationCheck =
  | { ok: true }
  | { ok: false; reason: ActivationRefusal; message: string };

// Only a chat model can be the active model. An embedding model loaded into the
// chat context produces no usable completion — the Models screen used to offer
// "Use this model" on one, which would have left the app with a loaded model
// that cannot answer anything.
const CHAT_ROLES: ModelRole[] = ["primary"];

export function canActivate(model: InstalledModel): ActivationCheck {
  if (!CHAT_ROLES.includes(model.role)) {
    return {
      ok: false,
      reason: "wrong-role",
      message:
        model.role === "embedding"
          ? "Embedding models power document search — they can't be the chat model."
          : `A ${model.role} model can't be the chat model.`,
    };
  }
  if (model.state === "downloading" || model.state === "paused") {
    return { ok: false, reason: "downloading", message: "Still downloading." };
  }
  if (model.state !== "ready") {
    return {
      ok: false,
      reason: "not-ready",
      // Names the way out. This is the state the legacy rows were stuck in,
      // with nothing on screen saying so.
      message: "This model needs verifying before it can be used.",
    };
  }
  return { ok: true };
}

/** Whether the Models screen should offer a Verify action for this row. */
export function canVerify(model: InstalledModel): boolean {
  if (model.state === "downloading" || model.state === "paused") return false;
  // Something to check against: a digest on record, or a repo to ask for one.
  return !!model.sha256 || (!!model.hfRepo && !!model.hfFile);
}
