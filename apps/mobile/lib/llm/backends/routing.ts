// Which lane a model BELONGS to — as opposed to which lane could take it now.
//
// These were one question, and conflating them is how a Snapdragon GGUF ended
// up answering from the CPU after an app restart.
//
// `ModelBackend.supports()` is a CAPABILITY answer: "can I run this, on this
// device, right now". It is the right question when nothing else is known
// about a file, and the registry's first-match-wins order is built on it. But
// it is a moving answer — the GenieX lane's own `supports()` is false until the
// runtime probe has completed — and `loadModel()` treated a false there as
// "this is not my model" and fell through to llama.rn. On a cold start that
// fallthrough is not a race that sometimes loses; the probe has not run yet, so
// it loses every time.
//
// A registry row already records the answer that does not move. `backend` is
// written at install or import (`geniex_llama_cpp` for a GGUF the GenieX model
// manager owns, `qualcomm_npu` for a QAIRT bundle) and it is a fact about the
// FILE, not about this boot. So routing asks that first, and a row that names
// a runtime is bound to it: either that lane loads it or the load fails with
// the lane's own words. There is no path from a declared row to another
// runtime — quietly running a GenieX-managed GGUF on llama.rn produces a CPU
// session under an accelerated model's name, which is the one outcome the
// three-lane split exists to prevent.
//
// Rows with no declaration — everything written before the column existed, and
// every caller that has a path and nothing else — keep the old order exactly:
// artifact first, then the GenieX claim, then llama.cpp, which can always run.

import { genieXLlamaCppBackend } from "./geniex-llamacpp-instance";
import { isNpuModel } from "../../models/npu-compat";
import type { BackendModelRef } from "./types";

/** The three runtimes a load can reach. */
export type LaneId = "qualcomm_npu" | "geniex_llama_cpp" | "llama_cpp";

export interface Routing {
  lane: LaneId;
  /**
   * True when the row's own `backend` column chose this lane, false when the
   * artifact-and-capability order did.
   *
   * Load-bearing for the fallback rule: a declared lane that cannot load is a
   * failure, and an undeclared model that nothing accelerated claims is a
   * llama.cpp model. Diagnostics shows it so "why is this on the CPU" has an
   * answer that does not require reading this file.
   */
  declared: boolean;
}

/** The lane this model belongs to. Never null: llama.cpp is the floor. */
export function routeModel(model: BackendModelRef): Routing {
  switch (model.backend) {
    case "qualcomm_npu":
      return { lane: "qualcomm_npu", declared: true };
    case "geniex_llama_cpp":
      return { lane: "geniex_llama_cpp", declared: true };
    default:
      break;
  }

  // Undeclared. The artifact is the strongest fact available: a context bundle
  // is unrunnable anywhere else, and guessing from a path is how one gets
  // handed to llama.cpp.
  if (isNpuModel(model)) return { lane: "qualcomm_npu", declared: false };
  // Capability, and legitimately so here: without a declaration the only thing
  // separating a GenieX-owned GGUF from a portable one is the runtime's own
  // claim on it, and a refusal genuinely does mean llama.cpp should take it.
  if (genieXLlamaCppBackend.supports(model)) {
    return { lane: "geniex_llama_cpp", declared: false };
  }
  return { lane: "llama_cpp", declared: false };
}
