import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySourceDraft,
  hasValidBlockDraftRanges,
  parseSourceDraft,
  type SourceDraft,
} from "../src/draft";

const legacyDraft: SourceDraft = {
  version: 2,
  docId: "doc",
  mode: "legacy",
  baseMarkdown: "before",
  currentMarkdown: "after",
  updatedAt: 1,
  cursorPosition: 5,
  cursorViewportY: null,
  blockRanges: null,
};

test("classifies drafts without overwriting a changed remote document", () => {
  assert.equal(classifySourceDraft(legacyDraft, {
    docId: "doc",
    mode: "legacy",
    currentMarkdown: "before",
  }), "recoverable");
  assert.equal(classifySourceDraft(legacyDraft, {
    docId: "doc",
    mode: "legacy",
    currentMarkdown: "after",
  }), "already-saved");
  assert.equal(classifySourceDraft(legacyDraft, {
    docId: "doc",
    mode: "legacy",
    currentMarkdown: "changed elsewhere",
  }), "conflict");
});

test("validates block draft identities, ranges, and projection separators", () => {
  const markdown = "alpha changed\n\nbeta";
  const ranges = [
    { id: "a", from: 0, to: 13 },
    { id: "b", from: 15, to: 19 },
  ];

  assert.equal(hasValidBlockDraftRanges(markdown, ranges, ["a", "b"]), true);
  assert.equal(hasValidBlockDraftRanges(markdown, ranges, ["b", "a"]), false);
  assert.equal(hasValidBlockDraftRanges("alpha changed\nbeta", ranges, ["a", "b"]), false);

  assert.equal(classifySourceDraft({
    ...legacyDraft,
    mode: "block",
    baseMarkdown: "alpha\n\nbeta",
    currentMarkdown: markdown,
    blockRanges: ranges,
  }, {
    docId: "doc",
    mode: "block",
    currentMarkdown: "alpha\n\nbeta",
    blockIds: ["a", "b"],
  }), "recoverable");
});

test("rejects malformed persisted draft data", () => {
  assert.equal(parseSourceDraft("not json"), null);
  assert.equal(parseSourceDraft(JSON.stringify({ ...legacyDraft, cursorPosition: -1 })), null);
  assert.deepEqual(parseSourceDraft(JSON.stringify(legacyDraft)), legacyDraft);
});
