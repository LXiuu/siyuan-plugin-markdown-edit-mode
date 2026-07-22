import assert from "node:assert/strict";
import test from "node:test";

import { EditorState } from "@codemirror/state";

import { createSiyuanSourceEditorSupport } from "../src/siyuan-protection";
import {
  collectSiyuanBlockEdits,
  createSiyuanSourceDocument,
  type SiyuanSourceBlock,
  validateSiyuanBlockEdit,
} from "../src/siyuan-source";

function createHarness() {
  const source = createSiyuanSourceDocument(
    [
      { id: "p1", type: "p", content: "alpha", markdown: "alpha" },
      {
        id: "q1",
        type: "query_embed",
        content: "query",
        markdown: "{{select * from blocks}}",
      },
      { id: "p2", type: "p", content: "omega", markdown: "omega" },
    ],
    "root",
  );
  const blocked: Array<SiyuanSourceBlock | null> = [];
  const support = createSiyuanSourceEditorSupport(source, {
    getBlockLabel: (block) => block.type,
    onBlockedEdit: (block) => blocked.push(block),
  });
  const state = EditorState.create({
    doc: source.markdown,
    extensions: [support.extension],
  });

  return { source, support, state, blocked };
}

test("allows edits at editable block boundaries and maps them into that block", () => {
  const { source, support, state } = createHarness();
  const first = support.getMappedBlocks(state)[0]!;
  const transaction = state.update({
    changes: { from: first.to, insert: "!" },
  });

  assert.equal(transaction.docChanged, true);
  assert.equal(transaction.state.doc.toString(), "alpha!\n\n{{select * from blocks}}\n\nomega");

  const mapped = support.getMappedBlocks(transaction.state);
  assert.deepEqual(mapped[0], { id: "p1", from: 0, to: 6 });
  assert.equal(mapped[1]!.from, source.blocks[1]!.from + 1);
  assert.deepEqual(
    collectSiyuanBlockEdits(source, mapped, transaction.state.doc.toString()),
    [{ id: "p1", type: "p", subType: null, markdown: "alpha!", from: 0, to: 6 }],
  );

  const prepend = state.update({ changes: { from: first.from, insert: ">" } });
  assert.equal(prepend.docChanged, true);
  assert.deepEqual(support.getMappedBlocks(prepend.state)[0], { id: "p1", from: 0, to: 6 });
});

test("rejects changes in projection separators", async () => {
  const { support, state, blocked } = createHarness();
  const first = support.getMappedBlocks(state)[0]!;
  const transaction = state.update({
    changes: { from: first.to + 1, insert: "x" },
  });

  assert.equal(transaction.docChanged, false);
  assert.equal(transaction.state.doc.toString(), state.doc.toString());
  await Promise.resolve();
  assert.deepEqual(blocked, [null]);
});

test("rejects insertions at and inside protected block boundaries", async () => {
  for (const selectPosition of ["from", "inside", "to"] as const) {
    const { support, state, blocked } = createHarness();
    const protectedRange = support.getMappedBlocks(state)[1]!;
    const position = selectPosition === "from"
      ? protectedRange.from
      : selectPosition === "to"
        ? protectedRange.to
        : protectedRange.from + 1;
    const transaction = state.update({ changes: { from: position, insert: "x" } });

    assert.equal(transaction.docChanged, false, selectPosition);
    await Promise.resolve();
    assert.equal(blocked.length, 1, selectPosition);
    assert.equal(blocked[0]?.id, "q1", selectPosition);
  }
});

test("rejects replacements that cross block or protected boundaries", async () => {
  const { support, state, blocked } = createHarness();
  const mapped = support.getMappedBlocks(state);
  const first = mapped[0]!;
  const protectedRange = mapped[1]!;
  const transaction = state.update({
    changes: { from: first.to - 1, to: protectedRange.from + 1, insert: "replacement" },
  });

  assert.equal(transaction.docChanged, false);
  await Promise.resolve();
  assert.equal(blocked[0]?.id, "q1");
});

test("filters an entire multi-change transaction when one change is protected", async () => {
  const { support, state, blocked } = createHarness();
  const mapped = support.getMappedBlocks(state);
  const transaction = state.update({
    changes: [
      { from: mapped[0]!.from + 1, insert: "A" },
      { from: mapped[1]!.from + 1, insert: "B" },
    ],
  });

  assert.equal(transaction.docChanged, false);
  assert.equal(transaction.state.doc.toString(), state.doc.toString());
  await Promise.resolve();
  assert.equal(blocked[0]?.id, "q1");
});

test("allows one transaction to edit multiple standard Markdown blocks", () => {
  const { source, support, state, blocked } = createHarness();
  const mapped = support.getMappedBlocks(state);
  const transaction = state.update({
    changes: [
      { from: mapped[0]!.from + 1, insert: "A" },
      { from: mapped[2]!.from + 1, insert: "B" },
    ],
  });

  assert.equal(transaction.docChanged, true);
  assert.deepEqual(blocked, []);
  assert.deepEqual(
    collectSiyuanBlockEdits(
      source,
      support.getMappedBlocks(transaction.state),
      transaction.state.doc.toString(),
    ).map((edit) => ({ id: edit.id, markdown: edit.markdown })),
    [
      { id: "p1", markdown: "aAlpha" },
      { id: "p2", markdown: "oBmega" },
    ],
  );
});

test("allows resizing a GFM table immediately before a protected block", () => {
  const source = createSiyuanSourceDocument(
    [
      {
        id: "table",
        type: "t",
        markdown: "| A | B |\n| --- | --- |\n| a | b |",
      },
      {
        id: "iframe",
        type: "iframe",
        markdown: '<iframe src="https://example.com"></iframe>',
      },
    ],
    "root",
  );
  const blocked: Array<SiyuanSourceBlock | null> = [];
  const support = createSiyuanSourceEditorSupport(source, {
    getBlockLabel: (block) => block.type,
    onBlockedEdit: (block) => blocked.push(block),
  });
  const state = EditorState.create({ doc: source.markdown, extensions: [support.extension] });
  const mappedBefore = support.getMappedBlocks(state);
  const tableBefore = mappedBefore[0]!;
  const protectedBefore = mappedBefore[1]!;
  const nextTable = [
    "| A | B | C |",
    "| :--- | ---: | :---: |",
    "| a | b | c |",
    "| d | e | f |",
  ].join("\n");
  const transaction = state.update({
    changes: { from: tableBefore.from, to: tableBefore.to, insert: nextTable },
  });

  assert.equal(transaction.docChanged, true);
  assert.deepEqual(blocked, []);

  const mappedAfter = support.getMappedBlocks(transaction.state);
  assert.deepEqual(mappedAfter[0], { id: "table", from: 0, to: nextTable.length });
  assert.equal(
    mappedAfter[1]!.from,
    protectedBefore.from + nextTable.length - (tableBefore.to - tableBefore.from),
  );

  const edits = collectSiyuanBlockEdits(
    source,
    mappedAfter,
    transaction.state.doc.toString(),
  );
  assert.deepEqual(edits.map((edit) => ({ id: edit.id, markdown: edit.markdown })), [
    { id: "table", markdown: nextTable },
  ]);
  assert.deepEqual(validateSiyuanBlockEdit(source.blocks[0]!, nextTable), { valid: true });
});

test("allows editing another editable block without moving protected source", () => {
  const { support, state } = createHarness();
  const mapped = support.getMappedBlocks(state);
  const protectedBefore = mapped[1]!;
  const last = mapped[2]!;
  const transaction = state.update({
    changes: { from: last.from + 1, to: last.from + 2, insert: "M" },
  });

  assert.equal(transaction.docChanged, true);
  assert.equal(transaction.state.doc.toString().endsWith("oMega"), true);
  assert.deepEqual(support.getMappedBlocks(transaction.state)[1], protectedBefore);
});

test("keeps an empty editable paragraph usable without exposing separators", async () => {
  const source = createSiyuanSourceDocument(
    [
      { id: "empty", type: "p", content: "", markdown: "" },
      { id: "q1", type: "query_embed", content: "query", markdown: "{{query}}" },
    ],
    "root",
  );
  const blocked: Array<SiyuanSourceBlock | null> = [];
  const support = createSiyuanSourceEditorSupport(source, {
    getBlockLabel: (block) => block.type,
    onBlockedEdit: (block) => blocked.push(block),
  });
  const state = EditorState.create({ doc: source.markdown, extensions: [support.extension] });
  const inserted = state.update({ changes: { from: 0, insert: "text" } });

  assert.equal(inserted.docChanged, true);
  assert.deepEqual(support.getMappedBlocks(inserted.state)[0], { id: "empty", from: 0, to: 4 });

  const separatorEdit = state.update({ changes: { from: 1, insert: "x" } });
  assert.equal(separatorEdit.docChanged, false);
  await Promise.resolve();
  assert.deepEqual(blocked, [null]);
});

test("allows list content edits but rejects list block-tree changes immediately", async () => {
  const source = createSiyuanSourceDocument(
    [{ id: "list", type: "l", subType: "u", markdown: "- alpha\n- beta" }],
    "root",
  );
  const blocked: Array<SiyuanSourceBlock | null> = [];
  const support = createSiyuanSourceEditorSupport(source, {
    getBlockLabel: (block) => block.type,
    onBlockedEdit: (block) => blocked.push(block),
  });
  const state = EditorState.create({ doc: source.markdown, extensions: [support.extension] });
  const textEdit = state.update({ changes: { from: 2, to: 7, insert: "**alpha**" } });

  assert.equal(textEdit.docChanged, true);
  assert.equal(textEdit.state.doc.toString(), "- **alpha**\n- beta");

  const structuralEdit = state.update({
    changes: { from: state.doc.length, insert: "\n- gamma" },
  });
  assert.equal(structuralEdit.docChanged, false);
  await Promise.resolve();
  assert.equal(blocked[0]?.id, "list");
});
