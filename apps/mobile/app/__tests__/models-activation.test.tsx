// The Models screen's activation controls, driven the way a finger drives them.
//
// The store already has its own single-flight tests, and they passed while the
// device did the opposite: model A said "Loading model…", model B was tapped,
// and B started loading. A store test could not have caught that, because it
// never renders the button the user actually presses. So this one does — the
// real screen, the real store action, the real control — and asserts the three
// things the device got wrong:
//
//   • the row that was tapped, and only that row, says "Loading model…"
//   • every other activation button is disabled while that runs
//   • a press that gets through anyway starts nothing and moves nothing
//
// The device agrees now: with three models installed, B loading leaves C
// disabled and nothing activates across rows.

import React from "react";
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { Text, TouchableOpacity } from "react-native";
import ModelsScreen from "../models";
import { useModelStore } from "../../lib/store/model-store";
import { listInstalled } from "../../lib/models/model-registry";
import { loadModel } from "../../lib/llm/llm-engine";
import type { InstalledModel } from "../../lib/models/types";

jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  cacheDirectory: "file:///cache/",
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1 })),
  copyAsync: jest.fn(async () => {}),
  makeDirectoryAsync: jest.fn(async () => {}),
  getFreeDiskStorageAsync: jest.fn(async () => 500e9),
  deleteAsync: jest.fn(async () => {}),
  moveAsync: jest.fn(async () => {}),
  readAsStringAsync: jest.fn(async () => {
    throw new Error("no cache");
  }),
  writeAsStringAsync: jest.fn(async () => {}),
  createDownloadResumable: jest.fn(),
}));
jest.mock("expo-document-picker", () => ({
  getDocumentAsync: jest.fn(async () => ({ canceled: true })),
}));
jest.mock("../../lib/models/model-registry", () => ({
  listInstalled: jest.fn(async () => []),
  getModelById: jest.fn(),
  getActiveModel: jest.fn(async () => null),
  insertModel: jest.fn(async (m) => ({ ...m, id: "row1" })),
  setModelState: jest.fn(async () => {}),
  setResumeToken: jest.fn(async () => {}),
  finalizeModel: jest.fn(async () => {}),
  finalizeBundle: jest.fn(async () => {}),
  setModelIntegrity: jest.fn(async () => {}),
  setActiveModel: jest.fn(async () => {}),
  removeModel: jest.fn(async () => {}),
}));
jest.mock("../../lib/native/npu", () => ({
  ...jest.requireActual("../../lib/native/npu"),
  npuBundleInfo: jest.fn(async () => null),
  npuRemoveBundle: jest.fn(async () => {}),
  onNpuPullProgress: jest.fn(() => () => {}),
}));
jest.mock("../../lib/models/download-manager", () => ({
  downloadModel: jest.fn(),
  cancelDownload: jest.fn(async () => {}),
  deleteModelFile: jest.fn(async () => {}),
  ensureModelsDir: jest.fn(async () => {}),
  modelPathFor: (f: string) => `file:///docs/models/${f}`,
}));
jest.mock("../../lib/models/gguf-header", () => ({
  checkGgufFile: jest.fn(async () => ({ ok: true })),
}));
jest.mock("../../lib/llm/llm-engine", () => ({
  loadModel: jest.fn(async () => {}),
  unloadModel: jest.fn(async () => {}),
  validateGguf: jest.fn(async () => ({ ok: true })),
  getModelInfo: jest.fn(() => ({ loaded: false })),
}));
jest.mock("../../lib/models/device-caps", () => ({
  getDeviceCaps: jest.fn(async () => ({
    freeBytes: 500e9,
    totalRamMb: 16384,
    deviceName: "Test",
    soc: null,
  })),
}));
jest.mock("../../lib/models/npu-ready", () => ({
  prepareNpuBackend: jest.fn(async () => ({
    inBuild: false,
    available: false,
    reason: null,
    runtimeVersion: null,
    soc: null,
    canonicalSoc: null,
    chipsets: undefined,
  })),
}));
jest.mock("../../lib/orchestrator/session-warmer", () => ({
  warmSessionCache: jest.fn(async () => {}),
}));
jest.mock("../../lib/llm/perf-config", () => ({
  getPerfSettings: jest.fn(async () => ({})),
  perfToLlmOptions: jest.fn(() => ({})),
}));
jest.mock("../../lib/store/chat-store", () => ({
  useChatStore: { getState: () => ({ updateModelStatus: jest.fn() }) },
}));

const mockList = listInstalled as jest.MockedFunction<typeof listInstalled>;
const mockLoad = loadModel as jest.MockedFunction<typeof loadModel>;
const mockGetById = jest.requireMock("../../lib/models/model-registry")
  .getModelById as jest.Mock;

function model(id: string, displayName: string): InstalledModel {
  return {
    id,
    displayName,
    hfRepo: null,
    hfFile: null,
    filePath: `file:///docs/models/${id}.gguf`,
    quant: "Q4_K_M",
    sizeBytes: 0,
    minRamMb: 4096,
    chatTemplate: null,
    contextSize: 4096,
    role: "primary",
    state: "ready",
    resumeToken: null,
    sha256: null,
    trust: "unverified",
    backend: "llama_cpp",
    artifact: "gguf",
    targetSoc: null,
    runtimeVersion: null,
    runtimeModelName: null,
    tokenizerPath: null,
    bundleFiles: [],
    isActive: false,
    createdAt: 0,
  } as InstalledModel;
}

const A = model("a", "Model A");
const B = model("b", "Model B");

/** A load that does not finish until the test says so — the ~14 s window. */
function pendingLoad() {
  let settle!: () => void;
  mockLoad.mockImplementation(
    () => new Promise<void>((resolve) => (settle = resolve)),
  );
  return { finish: () => settle() };
}

/** The literal strings rendered under a node, in order. */
function textsIn(node: ReactTestInstance): string[] {
  const collect = (children: unknown): string[] => {
    if (typeof children === "string") return [children];
    if (Array.isArray(children)) return children.flatMap(collect);
    return [];
  };
  return node.findAllByType(Text).flatMap((t) => collect(t.props.children));
}

/** Every pressable whose own label is exactly `label`. */
function buttons(tree: ReactTestRenderer, label: string): ReactTestInstance[] {
  return tree.root
    .findAllByType(TouchableOpacity)
    .filter((b) => textsIn(b).includes(label));
}

/** Every string anywhere on the screen. */
const screenTexts = (tree: ReactTestRenderer) => textsIn(tree.root);

// Every tree this file mounts, so none is left subscribed to the store while
// the next test resets it.
const mounted: ReactTestRenderer[] = [];

async function renderScreen(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ModelsScreen />);
  });
  mounted.push(tree);
  return tree;
}

afterEach(async () => {
  await act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  useModelStore.setState({
    error: null,
    busy: false,
    installed: [],
    progress: {},
    npuInstallErrors: {},
    activating: null,
    activationErrors: {},
  });
  mockList.mockResolvedValue([A, B]);
  mockGetById.mockImplementation(async (id: string) => (id === "a" ? A : B));
  mockLoad.mockResolvedValue(undefined);
});

describe("the Models screen while a model is loading", () => {
  it("shows Loading model… on the row that was tapped, and only that row", async () => {
    const load = pendingLoad();
    const tree = await renderScreen();

    expect(buttons(tree, "Use this model")).toHaveLength(2);

    await act(async () => {
      buttons(tree, "Use this model")[0].props.onPress();
    });

    expect(screenTexts(tree).filter((t) => t === "Loading model…")).toHaveLength(
      1,
    );
    expect(useModelStore.getState().activating).toBe("a");
    expect(mockLoad).toHaveBeenCalledTimes(1);

    await act(async () => {
      load.finish();
    });
  });

  it("disables every other activation button while it runs", async () => {
    const load = pendingLoad();
    const tree = await renderScreen();

    await act(async () => {
      buttons(tree, "Use this model")[0].props.onPress();
    });

    const others = buttons(tree, "Use this model");
    expect(others).toHaveLength(1); // B's; A's has become the spinner
    expect(others[0].props.disabled).toBe(true);

    await act(async () => {
      load.finish();
    });
  });

  it("starts nothing and moves nothing if B's press gets through anyway", async () => {
    const load = pendingLoad();
    const tree = await renderScreen();

    await act(async () => {
      buttons(tree, "Use this model")[0].props.onPress();
    });
    // Pressed regardless of `disabled` — the store is the gate that has to
    // hold when the screen's own is bypassed.
    await act(async () => {
      buttons(tree, "Use this model")[0].props.onPress();
    });

    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoad).toHaveBeenCalledWith(A.filePath, expect.anything());
    // The pending row did not move.
    expect(useModelStore.getState().activating).toBe("a");
    expect(screenTexts(tree).filter((t) => t === "Loading model…")).toHaveLength(
      1,
    );
    // B says why, on B's own row.
    expect(useModelStore.getState().activationErrors.b).toContain("Model A");

    await act(async () => {
      load.finish();
    });
    // And still nothing more after A resolves: the refusal was not a queue.
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it("puts the row back to Use this model, or Active, when the load ends", async () => {
    const load = pendingLoad();
    mockList.mockResolvedValue([{ ...A, isActive: true }, B]);
    const tree = await renderScreen();

    await act(async () => {
      buttons(tree, "Use this model")[0].props.onPress();
    });
    await act(async () => {
      load.finish();
    });

    expect(screenTexts(tree)).not.toContain("Loading model…");
    expect(screenTexts(tree)).toContain("● Active");
    expect(buttons(tree, "Use this model")[0].props.disabled).toBe(false);
  });

  it("survives the screen being unmounted mid-load and mounted again", async () => {
    const load = pendingLoad();
    const first = await renderScreen();

    await act(async () => {
      buttons(first, "Use this model")[0].props.onPress();
    });
    // The user presses Back.
    await act(async () => {
      mounted.splice(mounted.indexOf(first), 1);
      first.unmount();
    });

    // Nothing was cancelled by the unmount.
    expect(useModelStore.getState().activating).toBe("a");

    // The user comes back while it is still loading.
    const second = await renderScreen();
    expect(screenTexts(second).filter((t) => t === "Loading model…")).toHaveLength(
      1,
    );

    await act(async () => {
      load.finish();
    });
    // And the load that outlived the screen still recorded its result.
    const registry = jest.requireMock("../../lib/models/model-registry");
    expect(registry.setActiveModel).toHaveBeenCalledWith("a");
  });
});
