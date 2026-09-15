// The one QualcommNpuBackend instance.
//
// It lives here, on its own, rather than inside registry.ts for a structural
// reason: llm-engine needs it (that is where a load and a generation are
// actually routed), and registry.ts imports llamacpp-backend, which imports
// llm-engine. Putting the singleton in the registry would close that loop and
// Metro would resolve one of the three modules to a half-initialized namespace
// object at runtime.
//
// qnn-backend.ts imports nothing from llm-engine, so this module is a leaf and
// both sides can depend on it safely.

import { QualcommNpuBackend } from "./qnn-backend";

export const npuBackend = new QualcommNpuBackend();
