// The assistant card's layout contract.
//
// The bug this locks out: a long model answer grew the card past the bottom of
// the screen, the answer itself did not scroll, and Done / Open chat went with
// it — leaving the user stuck on a surface whose entire job is to get out of
// the way. So the claims here are structural, not cosmetic:
//
//   • the answer lives in a scroll region that is bounded rather than
//     content-sized, at any response length;
//   • the controls are siblings of that region, never inside it, so nothing
//     the model writes can push them off-screen;
//   • the model's Markdown is rendered rather than shown as syntax, using the
//     same pure-RN renderer the chat bubbles use — no HTML, no web view.

import React from "react";
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { Text, ScrollView, StyleSheet } from "react-native";
import { AssistOverlay } from "../AssistOverlay";
import { useAssistStore } from "../../lib/store/assist-store";

jest.mock("../../lib/orchestrator/orchestrator", () => ({
  processMessage: jest.fn(),
  executeToolCall: jest.fn(),
}));
jest.mock("../../lib/native/assist", () => ({
  startAssistCapture: jest.fn(async () => {}),
  finishAssistantActivity: jest.fn(),
}));
jest.mock("../../lib/native/speech", () => ({
  speak: jest.fn(async () => "done"),
  stopSpeaking: jest.fn(),
}));
jest.mock("../../lib/storage/database", () => ({
  getConfig: jest.fn(async () => null),
  createConversation: jest.fn(async () => {}),
  saveMessage: jest.fn(async () => {}),
  updateConversationTitle: jest.fn(async () => {}),
  touchConversation: jest.fn(async () => {}),
}));
jest.mock("uuid", () => ({ v4: () => "id" }));
jest.mock("../../lib/store/chat-store", () => ({
  useChatStore: {
    getState: () => ({ language: "en", ensureModelLoaded: jest.fn(async () => {}) }),
  },
}));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }),
}));

/** Every literal string rendered under `node`, in order. */
function textsIn(node: ReactTestInstance): string[] {
  const collect = (children: unknown): string[] => {
    if (typeof children === "string") return [children];
    if (Array.isArray(children)) return children.flatMap(collect);
    return [];
  };
  return node.findAllByType(Text).flatMap((t) => collect(t.props.children));
}

function render(message: string, phase: "answer" | "done" = "answer") {
  useAssistStore.setState({
    active: true,
    sessionId: 1,
    phase,
    transcript: "tell me about the hearth",
    message,
    failed: false,
  });
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(<AssistOverlay onOpenChat={() => {}} />);
  });
  mounted.push(tree);
  return tree;
}

// Unmounted before the store is cleared, so tearing a session down doesn't
// re-render a tree the test has finished with.
const mounted: ReactTestRenderer[] = [];

// Long enough that no phone, at any font scale, fits it on one screen.
const LONG_ANSWER = Array.from(
  { length: 120 },
  (_, i) => `Paragraph ${i + 1}. The hearth fire is tended and never goes out.`,
).join("\n\n");

afterEach(() => {
  act(() => {
    mounted.splice(0).forEach((tree) => tree.unmount());
  });
  useAssistStore.getState().endSession();
});

describe("a long answer cannot take the screen over", () => {
  it("puts the answer in a bounded, scrollable region", () => {
    const tree = render(LONG_ANSWER);
    const body = tree.root.findByType(ScrollView);
    const style = StyleSheet.flatten(body.props.style);

    // flexShrink so the region gives way to the header and controls;
    // flexGrow 0 so a one-line answer still renders a compact card. Together
    // they are what stops arbitrary model output setting the card's height.
    expect(style).toMatchObject({ flexShrink: 1, flexGrow: 0 });
    expect(textsIn(body).join(" ")).toContain("Paragraph 120.");
  });

  it("keeps the controls out of the scroll region, at every length", () => {
    for (const message of ["Yes.", LONG_ANSWER]) {
      const tree = render(message);
      const body = tree.root.findByType(ScrollView);

      expect(textsIn(tree.root)).toEqual(expect.arrayContaining(["Done", "Open chat"]));
      // Rendered as siblings of the answer, so no response length can scroll
      // them away or push them past the bottom of the viewport.
      expect(textsIn(body)).not.toContain("Done");
      expect(textsIn(body)).not.toContain("Open chat");
    }
  });

  it("clips the prompt instead of letting it eat the card", () => {
    const tree = render(LONG_ANSWER);
    const transcript = tree.root
      .findAllByType(Text)
      .find((node: ReactTestInstance) =>
        String(node.props.children).includes("tell me about the hearth"),
      );

    expect(transcript?.props.numberOfLines).toBe(2);
  });
});

describe("the model's answer is rendered, not shown as syntax", () => {
  it("renders emphasis, lists and inline code without their markers", () => {
    const tree = render(
      "This is **strong** and *soft*.\n\n- first item\n- second item\n\nUse `vesta()`.",
    );
    const body = tree.root.findByType(ScrollView);
    const text = textsIn(body).join(" ");

    expect(text).toContain("strong");
    expect(text).toContain("first item");
    expect(text).toContain("vesta()");
    // The syntax itself never reaches the user.
    expect(text).not.toContain("**strong**");
    expect(text).not.toContain("- first item");
    expect(text).not.toContain("`vesta()`");
  });

  it("leaves our own confirmation strings alone", () => {
    // A deterministic confirmation is a literal string Vesta wrote; a label
    // like "2 * 3" is not emphasis and must survive verbatim.
    const tree = render("Timer set: 2 * 3 minutes", "done");
    const body = tree.root.findByType(ScrollView);

    expect(textsIn(body)).toContain("Timer set: 2 * 3 minutes");
  });
});

describe("the full transcript can be inspected", () => {
  const LONG_PROMPT =
    "remind me on thursday afternoon to call the plumber about the leak under " +
    "the kitchen sink and also to ask whether the part he ordered last week " +
    "has finally arrived at the depot";

  function renderWith(transcript: string) {
    useAssistStore.setState({
      active: true,
      sessionId: 1,
      phase: "answer",
      transcript,
      message: "Reminder set.",
      failed: false,
    });
    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(<AssistOverlay onOpenChat={() => {}} />);
    });
    mounted.push(tree);
    return tree;
  }

  const transcriptNode = (tree: ReactTestRenderer) =>
    tree.root
      .findAllByType(Text)
      .find((node: ReactTestInstance) =>
        String(node.props.children).includes("plumber"),
      );

  it("shows two lines by default, outside the scroll region", () => {
    const tree = renderWith(LONG_PROMPT);

    expect(transcriptNode(tree)?.props.numberOfLines).toBe(2);
    // Collapsed, it is header furniture and must not scroll with the answer.
    expect(textsIn(tree.root.findByType(ScrollView)).join(" ")).not.toContain("plumber");
  });

  it("expands into the scroll region when tapped, unclipped", () => {
    const tree = renderWith(LONG_PROMPT);
    const toggle = tree.root.findByProps({
      accessibilityLabel: "Show what Vesta heard in full",
    });

    act(() => toggle.props.onPress());

    const expanded = transcriptNode(tree);
    // The whole utterance, so a misheard word is actually checkable...
    expect(expanded?.props.numberOfLines).toBeUndefined();
    // ...and it lives in the bounded, scrollable region, so however long the
    // dictation was it still cannot push Done and Open chat off screen.
    const body = tree.root.findByType(ScrollView);
    expect(textsIn(body).join(" ")).toContain("plumber");
    expect(textsIn(body)).not.toContain("Done");
    expect(textsIn(tree.root)).toEqual(expect.arrayContaining(["Done", "Open chat"]));
  });

  it("collapses again on a second tap", () => {
    const tree = renderWith(LONG_PROMPT);
    act(() =>
      tree.root
        .findByProps({ accessibilityLabel: "Show what Vesta heard in full" })
        .props.onPress(),
    );
    act(() =>
      tree.root
        .findByProps({ accessibilityLabel: "Collapse what Vesta heard" })
        .props.onPress(),
    );

    expect(transcriptNode(tree)?.props.numberOfLines).toBe(2);
  });
});

// The answer from the device screenshot that still showed its asterisks. The
// parser was never at fault: a model answer was reaching the branch that
// renders our own literal strings as plain text, because a chat-path response
// was being filed as the parser's clarification question. This renders the real
// output through the real surface.
describe("a real model answer, rendered on the assistant surface", () => {
  const ANSWER = [
    "Dwarves changed a lot between editions:",
    "",
    "**Original D&D (OD&D) – 1974:**",
    "- Dwarves were a *class*, not a race.",
    "- Capped at 6th level.",
    "",
    "**AD&D 1st Edition (1977–1979):** Race and class split, with level limits.",
    "",
    "**3rd Edition (2000):** Level limits dropped entirely.",
  ].join("\n");

  it("shows the words and none of the markers", () => {
    const tree = render(ANSWER);
    const text = textsIn(tree.root.findByType(ScrollView)).join(" ");

    expect(text).toContain("Original D&D (OD&D) – 1974:");
    expect(text).toContain("AD&D 1st Edition (1977–1979):");
    expect(text).toContain("Capped at 6th level.");
    expect(text).not.toContain("**");
    expect(text).not.toContain("- Dwarves");
  });

  it("keeps Done and Open chat reachable under all of it", () => {
    const tree = render(ANSWER);

    expect(textsIn(tree.root)).toEqual(expect.arrayContaining(["Done", "Open chat"]));
    expect(textsIn(tree.root.findByType(ScrollView))).not.toContain("Done");
  });
});
