import assert from "node:assert/strict";
import test from "node:test";

import {
  collectSiyuanBlockEdits,
  areSiyuanMarkdownBlocksEquivalent,
  createSiyuanSourceDocument,
  detectSiyuanMarkdownBlockType,
  getSiyuanChildBlockSource,
  matchesSiyuanBlockIal,
  matchesSiyuanKramdownSnapshot,
  matchesSiyuanKramdownIals,
  matchesSiyuanSourceSnapshot,
  movePositionOutsideProtectedBlock,
  prepareSiyuanBlockSourceForUpdate,
  prepareSiyuanListItemSourceForUpdate,
  summarizeSiyuanBlock,
  validateSiyuanBlockEdit,
  type SiyuanChildBlockData,
  type SiyuanSourceBlock,
} from "../src/siyuan-source";

const fixtureChildren: SiyuanChildBlockData[] = [
  { id: "p1", type: "p", content: "hello", markdown: "hello" },
  { id: "h1", type: "h", content: "Head", markdown: "# Head" },
  { id: "c1", type: "c", content: "const value = 1;", markdown: "~~~ts\nconst value = 1;\n~~~" },
  { id: "m1", type: "m", content: "x^2", markdown: "$$\nx^2\n$$" },
  { id: "tb1", type: "tb", content: "", markdown: "---" },
  { id: "l1", type: "l", content: "item", markdown: "- item" },
  { id: "s1", type: "s", content: "layout", markdown: "{{{col\nalpha\n}}}" },
  { id: "q1", type: "query_embed", content: "query", markdown: "{{select * from blocks}}" },
  {
    id: "av1",
    type: "av",
    content: "database",
    markdown: "<div data-type=\"NodeAttributeView\" data-av-id=\"av-id\"></div>",
  },
  { id: "u1", type: "future_block", content: "future", markdown: "future syntax" },
];

function makeBlock(type: string, markdown: string, content = markdown): SiyuanSourceBlock {
  return createSiyuanSourceDocument(
    [{ id: type + "-1", type, content, markdown }],
    "root",
  ).blocks[0]!;
}

test("projects top-level blocks into one Markdown document with stable ranges", () => {
  const source = createSiyuanSourceDocument(fixtureChildren, "root-kramdown");
  const expectedMarkdown = fixtureChildren
    .map((child) => child.markdown ?? child.content ?? "")
    .join("\n\n");

  assert.equal(source.markdown, expectedMarkdown);
  assert.equal(source.rootKramdown, "root-kramdown");

  let cursor = 0;
  source.blocks.forEach((block, index) => {
    if (index > 0) {
      cursor += 2;
    }

    assert.equal(block.from, cursor);
    cursor += block.markdown.length;
    assert.equal(block.to, cursor);
  });

  const presentationById = new Map(source.blocks.map((block) => [block.id, block.presentation]));
  for (const id of ["p1", "h1", "c1", "m1", "tb1", "l1"]) {
    assert.equal(presentationById.get(id), "editable-source");
  }
  assert.equal(presentationById.get("u1"), "locked-source");
  for (const id of ["s1", "q1", "av1"]) {
    assert.equal(presentationById.get(id), "card");
  }
});

test("protects paragraph source that SiYuan is known to rewrite lossily", () => {
  const source = createSiyuanSourceDocument(
    [{ id: "lossy-br", type: "p", markdown: "alpha<br>beta" }],
    "root",
  );
  const block = source.blocks[0]!;

  assert.equal(block.editable, false);
  assert.equal(block.presentation, "locked-source");
  assert.deepEqual(validateSiyuanBlockEdit(block, "alpha<br>changed"), {
    valid: false,
    issue: "protected",
  });
});

test("rejects missing editable Markdown and normalizes only the empty paragraph marker", () => {
  assert.throws(
    () => getSiyuanChildBlockSource({ id: "p1", type: "p", content: "visible", markdown: null }),
    /Missing Markdown source for editable SiYuan block p1/,
  );
  assert.throws(
    () => getSiyuanChildBlockSource({ id: "l1", type: "l", content: "- fallback", markdown: null }),
    /Missing Markdown source for editable SiYuan block l1/,
  );
  assert.equal(
    getSiyuanChildBlockSource({ id: "empty", type: "p", content: "", markdown: "\u200D" }),
    "",
  );
  assert.equal(
    getSiyuanChildBlockSource({ id: "literal", type: "p", content: "literal", markdown: "\u200D" }),
    "\u200D",
  );
  assert.equal(
    getSiyuanChildBlockSource({ id: "empty-null", type: "p", content: "", markdown: null }),
    "",
  );
  const emptyIal = '{: id="empty" style="color: red;"}';
  assert.equal(
    prepareSiyuanBlockSourceForUpdate("empty", "p", "", "old\n" + emptyIal),
    "\u200D\n" + emptyIal,
  );
  assert.equal(
    prepareSiyuanBlockSourceForUpdate("code", "c", "~~~\n~~~", 'old\n{: id="code"}'),
    '~~~\n~~~\n{: id="code"}',
  );
  const rubyBefore = [
    "<div>",
    "<ruby>好<rt>hǎo</rt></ruby><br>",
    "Hello World",
    "</div>",
    '{: id="ruby" updated="1"}',
  ].join("\n");
  const rubyOriginal = "<ruby>好<rt>hǎo</rt></ruby><br>\nHello World";
  const rubyEdited = "<ruby>好<rt>hǎo1</rt></ruby><br>\nHello World";
  assert.equal(
    prepareSiyuanBlockSourceForUpdate(
      "ruby",
      "html",
      rubyEdited,
      rubyBefore,
      rubyOriginal,
    ),
    rubyBefore.replace("hǎo", "hǎo1"),
  );
  assert.equal(
    prepareSiyuanBlockSourceForUpdate(
      "html",
      "html",
      "plain text",
      '<div>alpha</div>\n{: id="html"}',
      "<div>alpha</div>",
    ),
    '<div>\nplain text\n</div>\n{: id="html"}',
  );
  assert.throws(
    () => prepareSiyuanBlockSourceForUpdate("p1", "p", "changed", "plain"),
    /Missing block IAL for SiYuan block p1/,
  );
});

test("compares block IAL attributes semantically while preserving the original line", () => {
  const before = [
    "paragraph",
    '{: id="p1" style="color: red;" updated="1" custom-note="a\\\"b"}',
  ].join("\n");
  const reordered = [
    "changed",
    '{: custom-note="a\\\"b" updated="1" style="color: red;" id="p1"}',
  ].join("\n");
  const changed = [
    "changed",
    '{: custom-note="different" updated="1" style="color: red;" id="p1"}',
  ].join("\n");

  assert.equal(matchesSiyuanBlockIal("p1", before, reordered), true);
  assert.equal(matchesSiyuanBlockIal("p1", before, changed), false);
  assert.equal(matchesSiyuanBlockIal("wrong", before, reordered), false);
});

test("preserves inline list-item IALs and prepares only marker controls", () => {
  const before = [
    '- {: id="i1" custom-kind="task" updated="1"}[ ] alpha',
    '  {: id="p1" custom-child="yes" updated="1"}',
  ].join("\n");
  const reordered = [
    '- {: updated="1" custom-kind="task" id="i1"}[X] alpha',
    '  {: custom-child="yes" updated="1" id="p1"}',
  ].join("\n");

  assert.equal(matchesSiyuanBlockIal("i1", before, reordered), true);
  assert.equal(matchesSiyuanKramdownIals(before, reordered), true);
  assert.equal(
    matchesSiyuanKramdownIals(
      before,
      reordered.replace('custom-child="yes"', 'custom-child="no"'),
    ),
    false,
  );

  const prepared = prepareSiyuanListItemSourceForUpdate("i1", before, {
    originalMarker: "-",
    nextMarker: "*",
    originalTaskMarker: "[ ]",
    nextTaskMarker: "[X]",
  });
  assert.equal(prepared.startsWith('* {: id="i1" custom-kind="task" updated="1"}[X] alpha'), true);
  assert.equal(prepared.includes('{: id="p1" custom-child="yes" updated="1"}'), true);
});

test("compares GFM tables by cells and alignment instead of delimiter padding", () => {
  const compact = "| A | B |\n| :--- | ---: |\n| alpha | beta |";
  const padded = "| A     | B    |\n| :----- | ----: |\n| alpha | beta |";

  assert.equal(areSiyuanMarkdownBlocksEquivalent("t", compact, padded), true);
  assert.equal(
    areSiyuanMarkdownBlocksEquivalent("t", compact, padded.replace("beta", "changed")),
    false,
  );
  assert.equal(
    areSiyuanMarkdownBlocksEquivalent("t", compact, padded.replace("----:", ":----:")),
    false,
  );
  const escaped = "| A | B |\n| --- | --- |\n| alpha \\| one | beta |";
  const escapedPadded = "|A|B|\n| -------| ------|\n|alpha \\| one|beta|";
  assert.equal(areSiyuanMarkdownBlocksEquivalent("t", escaped, escapedPadded), true);
});

test("compares fenced code by info string and content instead of fence spelling", () => {
  const ticks = "\x60".repeat(3);
  const tildes = "~~~~";

  assert.equal(
    areSiyuanMarkdownBlocksEquivalent(
      "c",
      tildes + "ts\nconst value = 1;\n" + tildes,
      ticks + "ts\nconst value = 1;\n" + ticks,
    ),
    true,
  );
  assert.equal(
    areSiyuanMarkdownBlocksEquivalent(
      "c",
      tildes + "ts\nconst value = 1;\n" + tildes,
      ticks + "ts\nconst value = 2;\n" + ticks,
    ),
    false,
  );
  assert.equal(
    areSiyuanMarkdownBlocksEquivalent(
      "c",
      tildes + "text\nalpha\n" + ticks + "\nomega\n" + tildes,
      ticks + "text\nalpha\n\u200D" + ticks + "\nomega\n" + ticks,
    ),
    true,
  );
});


test("compares normalized standard leaf syntax semantically", () => {
  assert.equal(areSiyuanMarkdownBlocksEquivalent("p", "   ", ""), true);
  assert.equal(
    areSiyuanMarkdownBlocksEquivalent(
      "p",
      "<ruby>alpha</ruby><br>\nHello World",
      "<ruby>alpha</ruby>\n\nHello World",
    ),
    false,
  );
  assert.equal(
    areSiyuanMarkdownBlocksEquivalent("p", "alpha<br />beta", "alpha\nbeta"),
    false,
  );
  assert.equal(
    areSiyuanMarkdownBlocksEquivalent("p", "alpha<br>beta", "alpha\nchanged"),
    false,
  );
  assert.equal(
    areSiyuanMarkdownBlocksEquivalent(
      "html",
      "<ruby>alpha</ruby><br>\nHello World",
      "<div>\n<ruby>alpha</ruby><br>\nHello World\n</div>",
    ),
    true,
  );
  assert.equal(
    areSiyuanMarkdownBlocksEquivalent(
      "html",
      "<ruby>alpha</ruby><br>\nHello World",
      "<div>\n<ruby>changed</ruby><br>\nHello World\n</div>",
    ),
    false,
  );
  assert.equal(areSiyuanMarkdownBlocksEquivalent("h", "## alpha ##", "## alpha"), true);
  assert.equal(areSiyuanMarkdownBlocksEquivalent("h", "# ", "#"), true);
  assert.equal(areSiyuanMarkdownBlocksEquivalent("h", "   ## alpha", "## alpha"), true);
  assert.equal(areSiyuanMarkdownBlocksEquivalent("h", "## alpha", "### alpha"), false);
  assert.equal(areSiyuanMarkdownBlocksEquivalent("m", "$$\nx^2\n$$\n", "$$\nx^2\n$$"), true);
  assert.equal(areSiyuanMarkdownBlocksEquivalent("tb", "* * *", "---"), true);
});

test("compares root Kramdown semantically without hiding source changes", () => {
  const before = [
    "paragraph",
    '{: id="p1" style="color: red;" updated="1"}',
    "",
    '- {: id="li1" updated="1"}item',
    '    {: id="nested1" updated="1"}',
    '> {: id="quote1" updated="1"}quote',
    '`{: id="inline-literal" updated="1"}`',
    "~~~text",
    '{: id="literal" updated="1"}',
    "~~~",
    '{: id="code" updated="1"}',
  ].join("\n");
  const reordered = [
    "paragraph",
    '{: updated="1" id="p1" style="color: red;"}',
    "",
    '- {: updated="1" id="li1"}item',
    '    {: updated="1" id="nested1"}',
    '> {: updated="1" id="quote1"}quote',
    '`{: id="inline-literal" updated="1"}`',
    "~~~text",
    '{: id="literal" updated="1"}',
    "~~~",
    '{: updated="1" id="code"}',
  ].join("\r\n");
  const changedAttribute = reordered.replace('style="color: red;"', 'style="color: blue;"');
  const changedSource = reordered.replace("paragraph", "changed paragraph");
  const changedCodeLiteral = reordered.replace(
    '{: id="literal" updated="1"}',
    '{: updated="1" id="literal"}',
  );
  const changedInlineCodeLiteral = reordered.replace(
    '`{: id="inline-literal" updated="1"}`',
    '`{: updated="1" id="inline-literal"}`',
  );

  assert.equal(matchesSiyuanKramdownSnapshot(before, reordered), true);
  assert.equal(matchesSiyuanKramdownSnapshot(before, changedAttribute), false);
  assert.equal(matchesSiyuanKramdownSnapshot(before, changedSource), false);
  assert.equal(matchesSiyuanKramdownSnapshot(before, changedCodeLiteral), false);
  assert.equal(matchesSiyuanKramdownSnapshot(before, changedInlineCodeLiteral), false);
});

test("collects only changed block slices and protects projection separators", () => {
  const source = createSiyuanSourceDocument(
    [
      { id: "p1", type: "p", markdown: "alpha" },
      { id: "h1", type: "h", markdown: "# Heading" },
    ],
    "root",
  );
  const mapped = source.blocks.map(({ id, from, to }) => ({ id, from, to }));
  mapped[0]!.to += 1;
  mapped[1]!.from += 1;
  mapped[1]!.to += 1;

  assert.deepEqual(collectSiyuanBlockEdits(source, mapped, "alpha!\n\n# Heading"), [
    { id: "p1", type: "p", subType: null, markdown: "alpha!", from: 0, to: 6 },
  ]);

  const originalMapped = source.blocks.map(({ id, from, to }) => ({ id, from, to }));
  assert.throws(
    () => collectSiyuanBlockEdits(source, originalMapped, "alpha\nX# Heading"),
    /SiYuan source block boundaries changed/,
  );
  assert.throws(
    () => collectSiyuanBlockEdits(source, originalMapped.slice(0, 1), source.markdown),
    /Missing source range for SiYuan block h1/,
  );
});

test("matches snapshots only when order, identity, type, and source are unchanged", () => {
  const children = [
    { id: "p1", type: "p", markdown: "one" },
    { id: "p2", type: "p", markdown: "two" },
  ];
  const source = createSiyuanSourceDocument(children, "root");

  assert.equal(matchesSiyuanSourceSnapshot(source, children), true);
  source.blocks[0]!.markdown = "projection formatting";
  assert.equal(matchesSiyuanSourceSnapshot(source, children), true);
  assert.equal(matchesSiyuanSourceSnapshot(source, [...children].reverse()), false);
  assert.equal(
    matchesSiyuanSourceSnapshot(source, [children[0]!, { ...children[1]!, markdown: "changed" }]),
    false,
  );
  assert.equal(
    matchesSiyuanSourceSnapshot(source, [{ ...children[0]!, type: "h" }, children[1]!]),
    false,
  );
});

test("prioritizes standard Markdown edits while protecting destructive block changes", () => {
  const paragraph = makeBlock("p", "plain");
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "plain\ncontinuation"), { valid: true });
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, ""), { valid: true });
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "plain\n2. continuation"), { valid: true });
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "[ref]: https://example.com"), { valid: true });
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "<!-- retained as paragraph -->"), {
    valid: true,
  });
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "# heading"), {
    valid: true,
    nextType: "h",
  });
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "~~~js\nvalue\n~~~"), {
    valid: true,
    nextType: "c",
  });
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "$$\nx^2\n$$"), {
    valid: true,
    nextType: "m",
  });
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "<div>html</div>"), {
    valid: true,
    nextType: "html",
  });
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "- alpha\n- beta"), {
    valid: true,
    nextType: "l",
  });
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "> alpha"), {
    valid: true,
    nextType: "b",
  });
  assert.deepEqual(
    validateSiyuanBlockEdit(paragraph, "| A | B |\n| --- | --- |\n| a | b |"),
    { valid: false, issue: "changed-type" },
  );
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "one\n\ntwo"), {
    valid: false,
    issue: "multiple-blocks",
  });
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "one\n- item"), {
    valid: false,
    issue: "multiple-blocks",
  });
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "    indented code"), {
    valid: false,
    issue: "changed-type",
  });
  assert.deepEqual(validateSiyuanBlockEdit(paragraph, "Setext\n==="), {
    valid: false,
    issue: "changed-type",
  });

  const existingSetext = makeBlock("p", "Setext\n===");
  assert.deepEqual(validateSiyuanBlockEdit(existingSetext, "Setext edited\n==="), { valid: true });

  const heading = makeBlock("h", "# Heading");
  assert.deepEqual(validateSiyuanBlockEdit(heading, "## Renamed"), { valid: true });
  assert.deepEqual(validateSiyuanBlockEdit(heading, "## Renamed ##"), { valid: true });
  assert.deepEqual(validateSiyuanBlockEdit(heading, "# "), { valid: true });
  assert.deepEqual(validateSiyuanBlockEdit(heading, "   ## Renamed"), { valid: true });
  assert.deepEqual(validateSiyuanBlockEdit(heading, "Renamed"), {
    valid: true,
    nextType: "p",
  });
  assert.deepEqual(validateSiyuanBlockEdit(heading, "Renamed\n---"), {
    valid: false,
    issue: "changed-type",
  });

  const code = makeBlock("c", "~~~ts\nvalue\n~~~");
  assert.deepEqual(validateSiyuanBlockEdit(code, "~~~javascript\nchanged\n~~~\n"), {
    valid: true,
  });
  assert.deepEqual(validateSiyuanBlockEdit(code, "~~~~ts\nvalue\n~~~~"), { valid: true });
  assert.deepEqual(validateSiyuanBlockEdit(code, "~~~~ts\nvalue\n~~~"), {
    valid: false,
    issue: "invalid-fence",
  });
  const ticks = "\x60".repeat(3);
  assert.deepEqual(validateSiyuanBlockEdit(code, ticks + "js\nvalue\n" + ticks), { valid: true });
  assert.deepEqual(
    validateSiyuanBlockEdit(code, "~~~~text\nalpha\n" + ticks + "\nomega\n~~~~"),
    { valid: true },
  );
  assert.deepEqual(validateSiyuanBlockEdit(code, "plain"), {
    valid: true,
    nextType: "p",
  });

  const math = makeBlock("m", "$$\nx^2\n$$");
  assert.deepEqual(validateSiyuanBlockEdit(math, "$$\ny^2\n$$\n"), { valid: true });
  assert.deepEqual(validateSiyuanBlockEdit(math, "$$ y^2 $$"), {
    valid: true,
    nextType: "p",
  });

  const divider = makeBlock("tb", "---");
  assert.deepEqual(validateSiyuanBlockEdit(divider, "* * *"), { valid: true });
  assert.deepEqual(validateSiyuanBlockEdit(divider, "--"), {
    valid: true,
    nextType: "p",
  });

  const html = makeBlock("html", "<div>alpha</div>");
  assert.deepEqual(validateSiyuanBlockEdit(html, "<div data-kind=\"edited\">alpha</div>"), {
    valid: true,
  });
  assert.deepEqual(validateSiyuanBlockEdit(html, "plain"), { valid: true });

  const nativeRubyHtml = makeBlock(
    "html",
    "<ruby>好<rt>hǎo</rt></ruby><br>\nHello World",
  );
  assert.deepEqual(
    validateSiyuanBlockEdit(
      nativeRubyHtml,
      "<ruby>好<rt>hǎo1</rt></ruby><br>\nHello World",
    ),
    { valid: true },
  );
  assert.deepEqual(
    validateSiyuanBlockEdit(paragraph, '<iframe src="https://example.com"></iframe>'),
    { valid: false, issue: "changed-type" },
  );

  const list = makeBlock("l", "- alpha\n- beta");
  assert.deepEqual(validateSiyuanBlockEdit(list, "- **alpha edited**\n- beta"), { valid: true });
  assert.deepEqual(validateSiyuanBlockEdit(list, "- alpha\n- beta\n- gamma"), {
    valid: false,
    issue: "changed-structure",
  });
  const ordered = makeBlock("l", "9. alpha");
  assert.deepEqual(validateSiyuanBlockEdit(ordered, "8. alpha"), { valid: true });
  assert.deepEqual(validateSiyuanBlockEdit(ordered, "10. alpha"), {
    valid: false,
    issue: "changed-structure",
  });
  assert.deepEqual(validateSiyuanBlockEdit(ordered, "alpha"), {
    valid: true,
    nextType: "p",
  });

  const nestedList = makeBlock("l", "- alpha\n  - nested");
  assert.deepEqual(validateSiyuanBlockEdit(nestedList, "alpha\n  nested"), {
    valid: false,
    issue: "changed-structure",
  });

  const blockquote = makeBlock("b", "> alpha\n>\n> beta");
  assert.deepEqual(
    validateSiyuanBlockEdit(blockquote, "> [alpha](url)\n>\n> beta"),
    { valid: true },
  );
  assert.deepEqual(
    validateSiyuanBlockEdit(blockquote, "> alpha\n>\n> beta\n>\n> gamma"),
    { valid: false, issue: "changed-structure" },
  );
  assert.deepEqual(validateSiyuanBlockEdit(blockquote, "alpha"), {
    valid: false,
    issue: "changed-structure",
  });

  const singleParagraphBlockquote = makeBlock("b", "> alpha");
  assert.deepEqual(validateSiyuanBlockEdit(singleParagraphBlockquote, "alpha"), {
    valid: true,
    nextType: "p",
  });
  assert.deepEqual(
    validateSiyuanBlockEdit(singleParagraphBlockquote, "alpha\ncontinued"),
    { valid: true, nextType: "p" },
  );

  const singleHeadingBlockquote = makeBlock("b", "> # Heading");
  assert.deepEqual(validateSiyuanBlockEdit(singleHeadingBlockquote, "# Heading"), {
    valid: true,
    nextType: "h",
  });

  const table = makeBlock("t", "| A | B |\n| --- | --- |\n| a | b |");
  assert.deepEqual(
    validateSiyuanBlockEdit(table, "| A | B |\n| :--- | ---: |\n| a | b |\n| c | d |"),
    { valid: true },
  );
  assert.deepEqual(
    validateSiyuanBlockEdit(table, "| A | B | C |\n| --- | --- | --- |\n| a \\| x | b | c |"),
    { valid: true },
  );
  assert.deepEqual(
    validateSiyuanBlockEdit(table, "| A | B |\n| --- | --- |"),
    { valid: true },
  );
  assert.deepEqual(validateSiyuanBlockEdit(table, "plain"), {
    valid: false,
    issue: "changed-type",
  });
  assert.deepEqual(validateSiyuanBlockEdit(table, "| A | B |\n| --- | --- |\n| a | b |\n\nprose"), {
    valid: false,
    issue: "invalid-table",
  });
});

test("detects SiYuan and Markdown block shapes used by validation", () => {
  const cases: Array<[string, string]> = [
    ["", "p"],
    ["~~~js\nvalue\n~~~", "c"],
    ["$$\nx\n$$", "m"],
    ["### Heading", "h"],
    ["_ _ _", "tb"],
    ["- item", "l"],
    ["> quote", "b"],
    ["{{{col\n}}}", "s"],
    ["{{select * from blocks}}", "query_embed"],
    ["<div data-type=\"NodeAttributeView\"></div>", "av"],
    ['<iframe data-type="NodeWidget"></iframe>', "widget"],
    ['<iframe src="https://example.com"></iframe>', "iframe"],
    ['<video src="assets/video.mp4"></video>', "video"],
    ['<audio src="assets/audio.wav"></audio>', "audio"],
    ["<!-- comment -->", "p"],
    ["<script>value</script>", "p"],
    ["Setext\n===", "p"],
    ["[ref]: https://example.com", "p"],
    ["    indented code", "p"],
    ["| a |\n| --- |", "t"],
    ["<div>html</div>", "html"],
    ["ordinary text", "p"],
  ];

  for (const [markdown, expected] of cases) {
    assert.equal(detectSiyuanMarkdownBlockType(markdown), expected, markdown);
  }
});

test("moves initial cursors out of protected source and summarizes protected blocks", () => {
  const source = createSiyuanSourceDocument(
    [
      { id: "p1", type: "p", markdown: "alpha" },
      {
        id: "q1",
        type: "query_embed",
        content: "select     a lot\nfrom blocks",
        markdown: "{{select a lot from blocks}}",
      },
      { id: "p2", type: "p", markdown: "omega" },
    ],
    "root",
  );
  const protectedBlock = source.blocks[1]!;

  assert.equal(movePositionOutsideProtectedBlock(source, protectedBlock.from), protectedBlock.from);
  assert.equal(movePositionOutsideProtectedBlock(source, protectedBlock.from + 1), protectedBlock.from);
  assert.equal(movePositionOutsideProtectedBlock(source, protectedBlock.to - 1), protectedBlock.to);
  assert.equal(movePositionOutsideProtectedBlock(source, source.blocks[0]!.from + 1), 1);

  const summary = summarizeSiyuanBlock(protectedBlock, 12);
  assert.equal(summary.endsWith("…"), true);
  assert.equal(summary.length <= 12, true);
});
