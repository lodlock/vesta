import { parseInline, parseMarkdown } from "../parse";

describe("parseInline", () => {
  it("plain text", () => {
    expect(parseInline("hello world")).toEqual([{ t: "text", v: "hello world" }]);
  });
  it("bold", () => {
    expect(parseInline("a **b** c")).toEqual([
      { t: "text", v: "a " },
      { t: "bold", children: [{ t: "text", v: "b" }] },
      { t: "text", v: " c" },
    ]);
  });
  it("italic with both markers", () => {
    expect(parseInline("*x* and _y_")).toEqual([
      { t: "italic", children: [{ t: "text", v: "x" }] },
      { t: "text", v: " and " },
      { t: "italic", children: [{ t: "text", v: "y" }] },
    ]);
  });
  it("inline code is literal (no emphasis inside)", () => {
    expect(parseInline("run `a*b*c` now")).toEqual([
      { t: "text", v: "run " },
      { t: "code", v: "a*b*c" },
      { t: "text", v: " now" },
    ]);
  });
  it("bold containing italic", () => {
    expect(parseInline("**a _b_**")).toEqual([
      {
        t: "bold",
        children: [
          { t: "text", v: "a " },
          { t: "italic", children: [{ t: "text", v: "b" }] },
        ],
      },
    ]);
  });
  it("does NOT italicize intraword underscores (snake_case)", () => {
    expect(parseInline("call snake_case_name here")).toEqual([
      { t: "text", v: "call snake" },
      { t: "text", v: "_case_" },
      { t: "text", v: "name here" },
    ]);
  });
  it("does NOT italicize space-padded asterisks (math)", () => {
    const nodes = parseInline("compute 5 * 3 * 2 now");
    expect(nodes.every((n) => n.t === "text")).toBe(true);
    expect(nodes.map((n) => (n.t === "text" ? n.v : "")).join("")).toBe(
      "compute 5 * 3 * 2 now",
    );
  });
  it("still italicizes a real standalone _word_", () => {
    expect(parseInline("this is _important_ ok")).toEqual([
      { t: "text", v: "this is " },
      { t: "italic", children: [{ t: "text", v: "important" }] },
      { t: "text", v: " ok" },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("headings", () => {
    expect(parseMarkdown("# Title")).toEqual([
      { t: "h", level: 1, inline: [{ t: "text", v: "Title" }] },
    ]);
  });
  it("fenced code block keeps contents verbatim", () => {
    const blocks = parseMarkdown("```js\nconst x = 1;\n```");
    expect(blocks).toEqual([{ t: "code", v: "const x = 1;", lang: "js" }]);
  });
  it("unordered list groups consecutive items", () => {
    const blocks = parseMarkdown("- one\n- two");
    expect(blocks).toEqual([
      {
        t: "ul",
        items: [[{ t: "text", v: "one" }], [{ t: "text", v: "two" }]],
      },
    ]);
  });
  it("ordered list", () => {
    const blocks = parseMarkdown("1. a\n2. b");
    expect(blocks[0].t).toBe("ol");
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });
  it("paragraph joins soft-wrapped lines", () => {
    expect(parseMarkdown("hello\nworld")).toEqual([
      { t: "p", inline: [{ t: "text", v: "hello world" }] },
    ]);
  });
  it("separates blocks across blank lines", () => {
    const blocks = parseMarkdown("para one\n\n# Heading\n\n- item");
    expect(blocks.map((b) => b.t)).toEqual(["p", "h", "ul"]);
  });
  it("does not crash on unterminated formatting", () => {
    expect(() => parseMarkdown("**unclosed and `also")).not.toThrow();
  });
});

// Real model output, from a device screenshot where the asterisks were still
// visible on screen. The parser handled these all along — the answer was
// reaching a branch that rendered it as plain text — but the exact strings are
// pinned here so a regression in either layer has somewhere to fail.
describe("the shapes a model actually emits for a list of editions", () => {
  const bold = (blocks: ReturnType<typeof parseMarkdown>) =>
    JSON.stringify(blocks).includes('"t":"bold"');

  it("renders a bold run containing punctuation, ampersands and an en dash", () => {
    const blocks = parseMarkdown("**Original D&D (OD&D) – 1974:**");
    expect(blocks).toEqual([
      {
        t: "p",
        inline: [
          { t: "bold", children: [{ t: "text", v: "Original D&D (OD&D) – 1974:" }] },
        ],
      },
    ]);
  });

  it("renders a bold lead-in followed by its sentence", () => {
    expect(parseMarkdown("**AD&D 1st Edition (1977–1979):** Dwarves had level limits."))
      .toEqual([
        {
          t: "p",
          inline: [
            {
              t: "bold",
              children: [{ t: "text", v: "AD&D 1st Edition (1977–1979):" }],
            },
            { t: "text", v: " Dwarves had level limits." },
          ],
        },
      ]);
  });

  it("renders bold lead-ins inside bullet and numbered lists", () => {
    expect(bold(parseMarkdown("- **3rd Edition (2000):** Dwarves became a race."))).toBe(
      true,
    );
    expect(bold(parseMarkdown("* **4th Edition (2008):** Dwarves kept darkvision."))).toBe(
      true,
    );
    expect(bold(parseMarkdown("1. **5th Edition (2014):** Subraces returned."))).toBe(
      true,
    );
  });

  it("renders a mixed answer of paragraphs and a list, markers and all", () => {
    const answer = [
      "Here's how dwarves changed:",
      "",
      "**Original D&D (OD&D) – 1974:**",
      "- Dwarves were a *class*, not a race.",
      "- Limited to fighting men.",
      "",
      "**3rd Edition (2000):** Race and class finally separated.",
    ].join("\n");

    const rendered = JSON.stringify(parseMarkdown(answer));
    expect(rendered).toContain('"t":"bold"');
    expect(rendered).toContain('"t":"italic"');
    expect(rendered).toContain('"t":"ul"');
    // No marker survives into any text node.
    const texts: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        const n = node as Record<string, unknown>;
        if (n.t === "text" && typeof n.v === "string") texts.push(n.v);
        Object.values(n).forEach(walk);
      }
    };
    walk(parseMarkdown(answer));
    for (const text of texts) {
      expect(text).not.toContain("**");
      expect(text).not.toMatch(/^- /);
    }
  });
});
