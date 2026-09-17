// The one GenieXLlamaCppBackend instance.
//
// A leaf module, for the same reason npu-instance is one: llm-engine needs the
// singleton (that is where a load and a generation are actually routed) and
// registry.ts imports llamacpp-backend, which imports llm-engine. Holding the
// instance in the registry would close that cycle and Metro would hand one of
// the three modules a half-initialized namespace object at runtime.

import { GenieXLlamaCppBackend } from "./geniex-llamacpp-backend";

export const genieXLlamaCppBackend = new GenieXLlamaCppBackend();
